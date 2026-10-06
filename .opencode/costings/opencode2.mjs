// Turns opencode 2's events into the inputs the recorder (recorder.mjs) takes, which are shaped like opencode 1's hooks.
// Runtime-agnostic and free of any SQLite import: .opencode/plugins/usage-recorder.js wires it to opencode 2's event
// stream and tool hook.
//
// opencode 2 emits no event naming a slash command: its server expands the command's template (the markdown body of
// .opencode/commands/<name>.md) and enqueues the result as an ordinary user message. A command is therefore
// recognised by matching that message against the templates.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// `!`shell command`` is replaced by the command's output, $ARGUMENTS by everything typed after the command name,
// $1 to $9 by the individual arguments.
const TOKEN_RE = /!`[^`]*`|\$ARGUMENTS|\$[1-9]\d*/g;
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
// opencode 2's name for the tool opencode 1 and the recorder call "bash".
const SHELL_TOOL = 'shell';
// Steps that started and never ended (a cancelled reply) are forgotten, oldest first, beyond this many.
const MAX_OPEN_STEPS = 200;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lf = (text) => text.replace(/\r\n/g, '\n');
const isId = (value) => typeof value === 'string' && value !== '';
const isObject = (value) => value !== null && typeof value === 'object';

const ANY = '[\\s\\S]*?';
const FIRST_ARGUMENTS = `(${ANY})`;
const SAME_ARGUMENTS = '\\1';

/** One template as an anchored regular expression, or null when it has no text of its own (it would match anything). */
function compile(template) {
  const body = lf(template).trim();
  // The template as text, placeholder, text, placeholder ... text: the placeholders sit at the odd positions.
  const parts = [];
  let captured = false;
  let end = 0;
  for (const token of body.matchAll(TOKEN_RE)) {
    parts.push(body.slice(end, token.index));
    // Every $ARGUMENTS stands for the same text: the first one captures it, the others repeat it.
    parts.push(token[0] === '$ARGUMENTS' ? (captured ? SAME_ARGUMENTS : FIRST_ARGUMENTS) : ANY);
    captured ||= token[0] === '$ARGUMENTS';
    end = token.index + token[0].length;
  }
  parts.push(body.slice(end));
  let literal = 0;
  // Whitespace in the template matches any whitespace, or none: line endings and blank lines may change in transit.
  // A placeholder that takes any text takes the whitespace beside it as well, so only a repeated $ARGUMENTS needs it
  // matched here; leaving it out elsewhere keeps the pattern from backtracking over long runs of whitespace.
  const source = parts
    .map((part, i) => {
      if (i % 2) return part;
      literal += part.replace(/\s+/g, '').length;
      const before = parts[i - 1] === SAME_ARGUMENTS && /^\s/.test(part) ? '\\s*' : '';
      const after = parts[i + 1] === SAME_ARGUMENTS && /\s$/.test(part) ? '\\s*' : '';
      const words = part.trim() === '' ? [] : part.trim().split(/\s+/).map(escapeRegExp);
      return words.length ? before + words.join('\\s*') + after : before || after;
    })
    .join('');
  return literal === 0 ? null : { regex: new RegExp(`^${source}$`), literal, captured };
}

/**
 * `commands` is [{ name, template }], the template being the command's markdown without its frontmatter. Returns a
 * function from a user message to { name, arguments }, or null when the message is not an expanded command. When
 * several templates fit, the one with the most text of its own wins.
 */
export function commandMatcher(commands) {
  const compiled = [];
  for (const { name, template } of Array.isArray(commands) ? commands : []) {
    const entry = typeof name === 'string' && typeof template === 'string' ? compile(template) : null;
    if (entry) compiled.push({ name, ...entry });
  }
  return (text) => {
    if (typeof text !== 'string') return null;
    const message = lf(text).trim();
    let best = null;
    for (const { name, regex, literal, captured } of compiled) {
      const match = regex.exec(message);
      if (match && (!best || literal > best.literal)) best = { name, literal, arguments: captured ? match[1].trim() : '' };
    }
    return best && { name: best.name, arguments: best.arguments };
  };
}

/** The project's slash commands: [{ name, template }] from <root>/.opencode/commands/*.md, frontmatter removed. */
export function readCommands(root) {
  const dir = path.join(root, '.opencode', 'commands');
  let files;
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const commands = [];
  for (const file of files) {
    try {
      let text = readFileSync(path.join(dir, file), 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      commands.push({ name: file.slice(0, -'.md'.length), template: text.replace(FRONTMATTER_RE, '') });
    } catch {}
  }
  return commands;
}

/**
 * `recorder` is createRecorder()'s result; `commands` returns the current [{ name, template }] (it is called for each
 * user message, so an edited command is recognised without restarting opencode). Nothing here throws: an event that
 * is not understood is dropped.
 */
export function createOpencode2Adapter({ recorder, commands }) {
  // What each step started with: step.ended carries the tokens but not the agent or the model.
  const steps = new Map();

  const finishedReply = (info) =>
    recorder.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', ...info } } } });

  function onEvent(event) {
    const data = event?.data;
    if (!isObject(data) || !isId(data.sessionID)) return;
    switch (event.type) {
      case 'session.created':
        recorder.event({
          event: { type: 'session.created', properties: { info: { id: data.sessionID, parentID: data.parentID, time: { created: event.created } } } },
        });
        break;
      case 'session.inbox.enqueued': {
        if (data.item?.type !== 'user' || typeof data.item.payload?.text !== 'string') break;
        const command = commandMatcher(commands())(data.item.payload.text);
        if (command) recorder.commandBefore({ sessionID: data.sessionID, command: command.name, arguments: command.arguments });
        break;
      }
      case 'session.step.started':
        if (!isId(data.assistantMessageID)) break;
        steps.set(data.assistantMessageID, { agent: data.agent, providerID: data.model?.providerID, modelID: data.model?.id, started: data.started });
        if (steps.size > MAX_OPEN_STEPS) steps.delete(steps.keys().next().value);
        break;
      case 'session.step.ended': {
        if (!isId(data.assistantMessageID) || !isObject(data.tokens)) break;
        const step = steps.get(data.assistantMessageID);
        steps.delete(data.assistantMessageID);
        finishedReply({
          id: data.assistantMessageID,
          sessionID: data.sessionID,
          agent: step?.agent ?? 'unknown',
          providerID: step?.providerID,
          modelID: step?.modelID,
          cost: data.cost,
          tokens: data.tokens,
          time: { created: step?.started, completed: event.created },
        });
        break;
      }
      case 'session.usage.recorded':
        // A compaction is a model call of its own. A generated title is not recorded: opencode 1 did not record those either.
        if (data.source !== 'compaction' || !isId(event.id) || !isObject(data.tokens)) break;
        finishedReply({ id: event.id, sessionID: data.sessionID, agent: 'compaction', cost: data.cost, tokens: data.tokens, time: { completed: event.created } });
        break;
    }
  }

  function onToolAfter(call) {
    // opencode 1 ran this hook only for tool calls that succeeded.
    if (!isObject(call) || call.status === 'error') return;
    recorder.toolAfter({ tool: call.tool === SHELL_TOOL ? 'bash' : call.tool, sessionID: call.sessionID, args: call.input });
  }

  return {
    /** An event from opencode 2's event stream. */
    onEvent(event) {
      try {
        onEvent(event);
      } catch {}
    },
    /** opencode 2's `execute.after` tool hook. */
    onToolAfter(call) {
      try {
        onToolAfter(call);
      } catch {}
    },
  };
}
