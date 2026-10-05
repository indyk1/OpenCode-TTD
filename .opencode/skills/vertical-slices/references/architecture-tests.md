# Architecture tests

These rules make slice isolation a failing test instead of a convention. The project is owned by the human: agents cannot edit it, so the rules cannot be relaxed to get a slice to green. If `tests/<App>.ArchitectureTests` does not exist, senior-dev mentions it at checkpoint 1.

## Setup (the human, once)

```bash
dotnet new nunit -o tests/Shop.ArchitectureTests
rm tests/Shop.ArchitectureTests/UnitTest1.cs
dotnet add tests/Shop.ArchitectureTests reference src/Shop
dotnet add tests/Shop.ArchitectureTests package TngTech.ArchUnitNET
dotnet sln add tests/Shop.ArchitectureTests
```

`TngTech.ArchUnitNET` is Apache-2.0. The NUnit add-on package is not needed: the helper at the bottom of the file does its one job.

## `tests/Shop.ArchitectureTests/VerticalSliceRules.cs`

Set `Root` to the app's root namespace.

```csharp
using System.Text.RegularExpressions;
using ArchUnitNET.Domain;
using ArchUnitNET.Fluent;
using ArchUnitNET.Fluent.Extensions;
using ArchUnitNET.Fluent.Slices;
using ArchUnitNET.Loader;
using static ArchUnitNET.Fluent.ArchRuleDefinition;

namespace Shop.ArchitectureTests;

/// <summary>
/// The vertical slice rules. A slice is a namespace under Features.(Area).(Slice);
/// slice folders stay flat, because every distinct namespace counts as its own slice.
/// </summary>
public sealed class VerticalSliceRules
{
    private const string Root = "Shop";
    private static readonly string RootPattern = Regex.Escape(Root);

    private static readonly Architecture Architecture =
        new ArchLoader().LoadAssemblies(typeof(Program).Assembly).Build();

    [Test]
    public void Slices_do_not_depend_on_each_other() =>
        AssertHolds(
            SliceRuleDefinition.Slices()
                .Matching($"{Root}.Features.(*)")
                .Should()
                .NotDependOnEachOther());

    [Test]
    public void Shared_code_does_not_depend_on_features() =>
        AssertHolds(
            Types().That().ResideInNamespaceMatching($@"^{RootPattern}\.Shared(\..+)?$")
                .Should().NotDependOnAnyTypesThat().ResideInNamespaceMatching($@"^{RootPattern}\.Features(\..+)?$")
                .Because("shared code must never know about individual slices")
                .WithoutRequiringPositiveResults());

    [Test]
    public void Shared_domain_stays_free_of_infrastructure_and_web() =>
        AssertHolds(
            Types().That().ResideInNamespaceMatching($@"^{RootPattern}\.Shared\.Domain(\..+)?$")
                .Should().NotDependOnAnyTypesThat().ResideInNamespaceMatching($@"^({RootPattern}\.Shared\.Infrastructure|Microsoft\.AspNetCore)(\..+)?$")
                .Because("shared business rules must not depend on plumbing or HTTP")
                .WithoutRequiringPositiveResults());

    private static void AssertHolds(IArchRule rule)
    {
        if (!rule.HasNoViolations(Architecture))
        {
            Assert.Fail(rule.Evaluate(Architecture).ToErrorMessage());
        }
    }
}
```

What each rule protects:
- **Slices do not depend on each other** - a change to one use case cannot break another.
- **Shared code does not depend on features** - `Shared/` stays usable by every slice.
- **Shared/Domain stays free of infrastructure and web** - shared business rules are plain logic over values, easy to unit-test and to reason about.
