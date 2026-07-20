using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: A11yScout.Roslyn <repoPath>");
    Environment.Exit(1);
}

var repoPath = Path.GetFullPath(args[0]);
var controlRules = new Dictionary<string, ControlRule>(StringComparer.OrdinalIgnoreCase)
{
    ["Image"] = new(
        "aspnet/cs-image-missing-alt",
        "Code-behind Image control may be missing AlternateText",
        "A dynamically created Image control has no AlternateText assignment in its initializer or later statements. If rendered without alt text, screen readers cannot describe it (WCAG 1.1.1). Verify runtime output with scan-url.",
        "1.1.1",
        initializer => HasProperty(initializer, "AlternateText", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "AlternateText", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["ImageButton"] = new(
        "aspnet/cs-imagebutton-missing-alt",
        "Code-behind ImageButton may be missing AlternateText",
        "A dynamically created ImageButton has no AlternateText assignment in its initializer or later statements. If rendered without alt text, assistive tech users may not know the button purpose (WCAG 1.1.1). Verify runtime output with scan-url.",
        "1.1.1",
        initializer => HasProperty(initializer, "AlternateText", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "AlternateText", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["ImageMap"] = new(
        "aspnet/cs-imagemap-missing-alt",
        "Code-behind ImageMap may be missing AlternateText",
        "A dynamically created ImageMap has no AlternateText assignment in its initializer or later statements. If rendered without alternate text, screen reader users lose context (WCAG 1.1.1). Verify runtime output with scan-url.",
        "1.1.1",
        initializer => HasProperty(initializer, "AlternateText"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "AlternateText")),
    ["Button"] = new(
        "aspnet/cs-button-missing-text",
        "Code-behind Button may be missing Text",
        "A dynamically created Button has no Text assignment in its initializer or later statements. If rendered unnamed, assistive tech cannot announce the control purpose (WCAG 4.1.2). Verify runtime output with scan-url.",
        "4.1.2",
        initializer => HasProperty(initializer, "Text", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "Text", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["LinkButton"] = new(
        "aspnet/cs-linkbutton-missing-text",
        "Code-behind LinkButton may be missing Text",
        "A dynamically created LinkButton has no Text assignment in its initializer or later statements. If rendered unnamed, users cannot determine link purpose (WCAG 2.4.4). Verify runtime output with scan-url.",
        "2.4.4",
        initializer => HasProperty(initializer, "Text", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "Text", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["HyperLink"] = new(
        "aspnet/cs-hyperlink-missing-text",
        "Code-behind HyperLink may be missing Text",
        "A dynamically created HyperLink has no Text assignment in its initializer or later statements. If rendered unnamed, users cannot determine link purpose (WCAG 2.4.4). Verify runtime output with scan-url.",
        "2.4.4",
        initializer => HasProperty(initializer, "Text", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "Text", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["CheckBox"] = new(
        "aspnet/cs-checkbox-missing-text",
        "Code-behind CheckBox may be missing label text",
        "A dynamically created CheckBox has no Text assignment in its initializer or later statements. If rendered unnamed, assistive tech users cannot identify the field (WCAG 1.3.1). Verify runtime output with scan-url.",
        "1.3.1",
        initializer => HasProperty(initializer, "Text", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "Text", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["RadioButton"] = new(
        "aspnet/cs-radiobutton-missing-text",
        "Code-behind RadioButton may be missing label text",
        "A dynamically created RadioButton has no Text assignment in its initializer or later statements. If rendered unnamed, assistive tech users cannot identify the field (WCAG 1.3.1). Verify runtime output with scan-url.",
        "1.3.1",
        initializer => HasProperty(initializer, "Text", "ToolTip") || HasAttributeAssignment(initializer, "aria-label", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "Text", "ToolTip") || IsAttributeAssignmentTo(variableName, left, "aria-label", "title", "alt")),
    ["TextBox"] = new(
        "aspnet/cs-textbox-missing-label-hint",
        "Code-behind TextBox has no inline labeling hint",
        "A dynamically created TextBox has no obvious aria-label, aria-labelledby, or ToolTip assignment in its initializer or later statements. A separate Label control may still exist, so confirm at runtime (WCAG 3.3.2).",
        "3.3.2",
        initializer => HasProperty(initializer, "ToolTip", "Text") || HasAttributeAssignment(initializer, "aria-label", "aria-labelledby", "title", "alt"),
        (variableName, left) => IsPropertyAssignmentTo(variableName, left, "ToolTip", "Text") || IsAttributeAssignmentTo(variableName, left, "aria-label", "aria-labelledby", "title", "alt")),
};

var files = Directory
    .EnumerateFiles(repoPath, "*.cs", SearchOption.AllDirectories)
    .Where(path => !path.Contains("\\node_modules\\", StringComparison.OrdinalIgnoreCase))
    .Where(path => !path.Contains("\\bin\\", StringComparison.OrdinalIgnoreCase))
    .Where(path => !path.Contains("\\obj\\", StringComparison.OrdinalIgnoreCase))
    .ToArray();

var issues = new List<RoslynIssue>();
foreach (var filePath in files)
{
    AnalyzeFile(repoPath, filePath, issues);
}

var payload = new RoslynScanResult(files.Length, files.Select(path => Path.GetRelativePath(repoPath, path).Replace('\\', '/')).ToArray(), issues);
Console.WriteLine(JsonSerializer.Serialize(payload));

void AnalyzeFile(string repoPath, string filePath, List<RoslynIssue> issues)
{
    var content = File.ReadAllText(filePath);
    var tree = CSharpSyntaxTree.ParseText(content, path: filePath);
    var root = tree.GetRoot();
    var relativePath = Path.GetRelativePath(repoPath, filePath).Replace('\\', '/');

    foreach (var localDeclaration in root.DescendantNodes().OfType<LocalDeclarationStatementSyntax>())
    {
        foreach (var variable in localDeclaration.Declaration.Variables)
        {
            if (variable.Initializer?.Value is not ObjectCreationExpressionSyntax objectCreation)
            {
                continue;
            }

            var typeName = GetTypeName(objectCreation.Type);
            if (!controlRules.TryGetValue(typeName, out var controlRule))
            {
                continue;
            }

            var variableName = variable.Identifier.Text;
            if (HasRequiredAssignment(objectCreation, variableName, localDeclaration, controlRule))
            {
                continue;
            }

            var lineSpan = tree.GetLineSpan(objectCreation.Span);
            issues.Add(new RoslynIssue(
                controlRule.RuleId,
                controlRule.Title,
                controlRule.Description,
                controlRule.WcagSc,
                relativePath,
                lineSpan.StartLinePosition.Line + 1,
                lineSpan.StartLinePosition.Character + 1,
                objectCreation.ToString()));
        }
    }

    foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
        {
            continue;
        }

        var methodName = memberAccess.Name.Identifier.Text;
        if (methodName is not ("RegisterClientScriptInclude" or "RegisterStartupScriptInclude" or "RegisterScriptInclude"))
        {
            continue;
        }

        var jsPath = invocation.ArgumentList.Arguments
            .Select(arg => arg.Expression)
            .OfType<LiteralExpressionSyntax>()
            .FirstOrDefault(lit => lit.IsKind(SyntaxKind.StringLiteralExpression) && lit.Token.ValueText.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            ?.Token.ValueText ?? "(dynamic script path)";

        var hint = jsPath.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? "This appears to be a remote script URL."
            : "If this script is outside the scanned repo path, it will not be statically analyzed.";

        var lineSpan = tree.GetLineSpan(invocation.Span);
        issues.Add(new RoslynIssue(
            "aspnet/cs-script-include",
            "Code-behind registers external JavaScript include",
            $"A code-behind script include was found ({jsPath}). {hint} The repo scanner still analyzes in-repo JS files directly, but runtime-rendered behavior must be verified with scan-url.",
            "4.1.2",
            relativePath,
            lineSpan.StartLinePosition.Line + 1,
            lineSpan.StartLinePosition.Character + 1,
            invocation.ToString()));
    }
}

bool HasRequiredAssignment(
    ObjectCreationExpressionSyntax objectCreation,
    string variableName,
    LocalDeclarationStatementSyntax declaration,
    ControlRule controlRule)
{
    if (controlRule.IsSatisfiedByInitializer(objectCreation.Initializer))
    {
        return true;
    }

    var block = declaration.Parent;
    if (block is null)
    {
        return false;
    }

    var aliases = CollectControlAliases(variableName, declaration, block);

    foreach (var assignment in block.DescendantNodes().OfType<AssignmentExpressionSyntax>())
    {
        if (assignment.SpanStart <= declaration.SpanStart)
        {
            continue;
        }

        if (aliases.Any(alias => controlRule.IsSatisfiedByAssignment(alias, assignment.Left)))
        {
            return true;
        }
    }

    if (HasAssociatedLabelForControl(aliases, declaration, block))
    {
        return true;
    }

    if (HasAccessibleNamedContainerAdd(aliases, declaration, block))
    {
        return true;
    }

    return false;
}

HashSet<string> CollectControlAliases(string variableName, LocalDeclarationStatementSyntax declaration, SyntaxNode block)
{
    var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { variableName };
    var changed = true;

    while (changed)
    {
        changed = false;

        foreach (var local in block.DescendantNodes().OfType<VariableDeclarationSyntax>())
        {
            foreach (var declarator in local.Variables)
            {
                if (declarator.Initializer?.Value is IdentifierNameSyntax rhs && aliases.Contains(rhs.Identifier.Text))
                {
                    if (aliases.Add(declarator.Identifier.Text))
                    {
                        changed = true;
                    }
                }
            }
        }

        foreach (var assignment in block.DescendantNodes().OfType<AssignmentExpressionSyntax>())
        {
            if (assignment.SpanStart <= declaration.SpanStart)
            {
                continue;
            }

            if (assignment.Left is IdentifierNameSyntax lhs && assignment.Right is IdentifierNameSyntax rhs && aliases.Contains(rhs.Identifier.Text))
            {
                if (aliases.Add(lhs.Identifier.Text))
                {
                    changed = true;
                }
            }
        }
    }

    return aliases;
}

bool HasAssociatedLabelForControl(HashSet<string> variableNames, LocalDeclarationStatementSyntax declaration, SyntaxNode block)
{
    var candidateIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (var assignment in block.DescendantNodes().OfType<AssignmentExpressionSyntax>())
    {
        if (assignment.SpanStart <= declaration.SpanStart)
        {
            continue;
        }

        if (!variableNames.Any(name => IsPropertyAssignmentTo(name, assignment.Left, "ID")))
        {
            continue;
        }

        if (assignment.Right is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression))
        {
            candidateIds.Add(literal.Token.ValueText);
        }
    }

    foreach (var labelCreation in block.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
    {
        if (!string.Equals(GetTypeName(labelCreation.Type), "Label", StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        var initializer = labelCreation.Initializer;
        if (initializer is null)
        {
            continue;
        }

        var hasText = initializer.Expressions
            .OfType<AssignmentExpressionSyntax>()
            .Any(assign => assign.Left is IdentifierNameSyntax id && string.Equals(id.Identifier.Text, "Text", StringComparison.OrdinalIgnoreCase));
        if (!hasText)
        {
            continue;
        }

        foreach (var assign in initializer.Expressions.OfType<AssignmentExpressionSyntax>())
        {
            if (assign.Left is not IdentifierNameSyntax leftId || !string.Equals(leftId.Identifier.Text, "AssociatedControlID", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var rhs = assign.Right.ToString();
            if (variableNames.Any(name => rhs.Equals($"{name}.ID", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }

            if (assign.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression) && candidateIds.Contains(lit.Token.ValueText))
            {
                return true;
            }
        }
    }

    return false;
}

bool HasAccessibleNamedContainerAdd(HashSet<string> variableNames, LocalDeclarationStatementSyntax declaration, SyntaxNode block)
{
    foreach (var invocation in block.DescendantNodes().OfType<InvocationExpressionSyntax>())
    {
        if (invocation.SpanStart <= declaration.SpanStart)
        {
            continue;
        }

        if (invocation.Expression is not MemberAccessExpressionSyntax member ||
            !string.Equals(member.Name.Identifier.Text, "Add", StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        if (member.Expression is not MemberAccessExpressionSyntax controlsAccess ||
            !string.Equals(controlsAccess.Name.Identifier.Text, "Controls", StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        var addedArg = invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        if (addedArg is not IdentifierNameSyntax addedIdentifier || !variableNames.Contains(addedIdentifier.Identifier.Text))
        {
            continue;
        }

        var containerExpr = controlsAccess.Expression;
        if (containerExpr is IdentifierNameSyntax containerName)
        {
            if (ContainerHasAccessibleName(containerName.Identifier.Text, declaration, block))
            {
                return true;
            }
        }

        if (containerExpr is ThisExpressionSyntax)
        {
            // Top-level page/user-control container may have an implicit heading/title.
            return true;
        }
    }

    return false;
}

bool ContainerHasAccessibleName(string containerVariable, LocalDeclarationStatementSyntax declaration, SyntaxNode block)
{
    foreach (var assignment in block.DescendantNodes().OfType<AssignmentExpressionSyntax>())
    {
        if (assignment.SpanStart <= declaration.SpanStart)
        {
            continue;
        }

        if (IsPropertyAssignmentTo(containerVariable, assignment.Left, "Text", "ToolTip", "GroupingText", "HeaderText", "Title"))
        {
            return true;
        }

        if (IsAttributeAssignmentTo(containerVariable, assignment.Left, "aria-label", "title", "alt"))
        {
            return true;
        }
    }

    foreach (var local in block.DescendantNodes().OfType<LocalDeclarationStatementSyntax>())
    {
        foreach (var variable in local.Declaration.Variables)
        {
            if (!string.Equals(variable.Identifier.Text, containerVariable, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (variable.Initializer?.Value is ObjectCreationExpressionSyntax creation)
            {
                if (HasProperty(creation.Initializer, "Text", "ToolTip", "GroupingText", "HeaderText", "Title") ||
                    HasAttributeAssignment(creation.Initializer, "aria-label", "title", "alt"))
                {
                    return true;
                }
            }
        }
    }

    return false;
}

string GetTypeName(TypeSyntax typeSyntax)
{
    var text = typeSyntax.ToString();
    var lastDot = text.LastIndexOf('.');
    return lastDot >= 0 ? text[(lastDot + 1)..] : text;
}

bool HasProperty(InitializerExpressionSyntax? initializer, params string[] propertyNames)
{
    if (initializer is null)
    {
        return false;
    }

    return initializer.Expressions
        .OfType<AssignmentExpressionSyntax>()
        .Select(assignment => assignment.Left)
        .OfType<IdentifierNameSyntax>()
        .Any(identifier => propertyNames.Contains(identifier.Identifier.Text, StringComparer.OrdinalIgnoreCase));
}

bool HasAttributeAssignment(InitializerExpressionSyntax? initializer, params string[] attributeNames)
{
    if (initializer is null)
    {
        return false;
    }

    foreach (var assignment in initializer.Expressions.OfType<AssignmentExpressionSyntax>())
    {
        if (assignment.Left is not ElementAccessExpressionSyntax elementAccess)
        {
            continue;
        }

        if (elementAccess.Expression.ToString() != "Attributes")
        {
            continue;
        }

        var key = elementAccess.ArgumentList.Arguments.FirstOrDefault()?.Expression.ToString().Trim('"', '\'');
        if (key is not null && attributeNames.Contains(key, StringComparer.OrdinalIgnoreCase))
        {
            return true;
        }
    }

    return false;
}

bool IsPropertyAssignmentTo(string variableName, ExpressionSyntax left, params string[] propertyNames)
{
    if (left is MemberAccessExpressionSyntax memberAccess &&
        memberAccess.Expression.ToString() == variableName)
    {
        return propertyNames.Contains(memberAccess.Name.Identifier.Text, StringComparer.OrdinalIgnoreCase);
    }

    return false;
}

bool IsAttributeAssignmentTo(string variableName, ExpressionSyntax left, params string[] attributeNames)
{
    if (left is not ElementAccessExpressionSyntax elementAccess)
    {
        return false;
    }

    if (elementAccess.Expression is not MemberAccessExpressionSyntax memberAccess ||
        memberAccess.Expression.ToString() != variableName ||
        memberAccess.Name.Identifier.Text != "Attributes")
    {
        return false;
    }

    var key = elementAccess.ArgumentList.Arguments.FirstOrDefault()?.Expression.ToString().Trim('"', '\'');
    return key is not null && attributeNames.Contains(key, StringComparer.OrdinalIgnoreCase);
}

internal sealed record RoslynIssue(
    string RuleId,
    string Title,
    string Description,
    string WcagSc,
    string FilePath,
    int Line,
    int Column,
    string HtmlSnippet);

internal sealed record RoslynScanResult(
    int FilesScanned,
    string[] ScannedFiles,
    List<RoslynIssue> Issues);

internal sealed record ControlRule(
    string RuleId,
    string Title,
    string Description,
    string WcagSc,
    Func<InitializerExpressionSyntax?, bool> IsSatisfiedByInitializer,
    Func<string, ExpressionSyntax, bool> IsSatisfiedByAssignment);