# How to drive this

You describe what you want in your own words. A small team of AI agents plans it, writes the tests, builds it and checks it - and comes back to you whenever it needs a decision. You never need to read or write code.

## Before the first time - ask someone technical, once
They copy this template into your project folder, install the .NET 10 SDK and Node.js, and run `node scripts/install-tools.mjs` there. It installs the rest - opencode, the OpenSpec CLI, the Aspire CLI and the debugger's browser among them - and says what is still needed, such as git with your name and email, Podman (so the app can run its database on your computer) and signing opencode in to Claude. It works the same on Windows, macOS and Linux. `.opencode/docs/setup.md` has the details.

## Starting
Open a terminal in your project folder, type `opencode` and press Enter.

## What you can ask for

| Type | When | Example |
|---|---|---|
| `/setup` | once, for a brand-new app | `/setup Acme Orders - lets small shops take orders online and track deliveries` |
| `/feature` | you want something new | `/feature Shop owners can see today's orders, newest first` |
| `/bug` | something isn't working | `/bug On the orders page, cancelling an order with two items shows an error. I expected "Order cancelled".` |
| `/deploy` | put the app online, or update it | `/deploy` |
| `/resume` | carry on after closing opencode | `/resume cancel-orders` |
| `/costings` | see how many tokens each feature and bug used | `/costings` |

**Good requests** say who does what, and why: "Shop staff see new orders appear straight away, so they can start packing" works better than "add SignalR". Don't name technologies - those were chosen at setup, and the agents translate. Ask for one thing at a time, smallest first.

**Good bug reports** say what you did, what happened, what you expected, which page, and which account if it matters. If it is broken for real customers right now, say so first - the safest move is usually to put the last working version back, then fix it properly.

**What happens with a bug.** The debugger tries it on a copy of the app on your computer and explains what is wrong in plain English. Sometimes the answer is "this is how it was agreed to work" - then you are asked whether to change it, and it becomes a feature. Otherwise a test is written that fails *because of the bug*, and you approve the diagnosis and that proof together. After the fix you accept it, and it is saved. Bugs need two approvals instead of three.

## The two kinds of pop-up

**Questions** - the agents need a decision. Pick an option (the recommended one is marked) or type your own answer. If you don't understand, type: *explain that in plain English*.

**Permission prompts** - these are your signature. **Always choose "Allow once".** For each feature or bug you will see three:
1. *launch test-writer* - the tests can be written (for a bug: the test that reproduces it).
2. *scripts/lock-tests.sh* - you approved the tests, so they are locked: the code has to satisfy them.
3. *scripts/finish-change.sh* - you accepted the result, so it is saved.

You may also be asked when a new building block (a package) is added, when a rule shared between several parts of the app changes, or before `/deploy` creates anything that costs money. If you are not sure what a prompt is for, choose **Reject** and ask.

## Golden rules
- **"Allow once" - never "Always".** "Always" can switch a checkpoint off for good.
- Never start opencode with `--auto`.
- One feature or bug per session. When it is finished, start a new session.
- Lost? Ask *where are we?* If opencode closed, use `/resume`.

## The debugger's test account
If your app has sign-in, the debugger needs its own account to test with. When sign-in is first built, the plan includes a test account that only exists on your computer. Put its email and password in `.workflow/debugger.env` (any text editor will do). Never use a real person's account. That file never leaves your computer.

## Seeing the app yourself
Open a second terminal in the project folder and type `aspire start`. It prints the address of the dashboard, which links to your app. `aspire stop` stops it.

**After restarting a Mac or a Windows PC that uses Podman,** start Podman before you start opencode: type `podman machine start` in a terminal (or open Podman Desktop, if it was installed). Otherwise the app's database cannot start and the agents will say so.
