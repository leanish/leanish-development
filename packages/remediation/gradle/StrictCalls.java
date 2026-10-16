import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Lists what a Gradle build script says about strict versions, parsed (never run) with the compilers the build's own
 * Gradle distribution ships: Kotlin's for `.kt`/`.kts`, Groovy's otherwise. Run with Java's source launcher:
 * `java -cp <the distribution's lib jars> StrictCalls.java <file>...`.
 *
 * <p>Prints one line per finding, `<file> TAB <kind> TAB <text>`, the text escaped so no two differ only by a newline:
 * <ul>
 *   <li>`call`: a direct `strictly(...)` call, with full receivers, navigation operators, type arguments and every
 *       enclosing call's non-closure arguments (the
 *       dependency it pins, `implementation("g:a") { version { strictly("1.0") } }`);</li>
 *   <li>`indirect`: anything else that names `strictly`: a dynamic method name, a property, or a string holding the
 *       word, with the whole call it's an argument of (`invokeMethod('strictly', ['1.0'])`). They aren't followed, so
 *       comparing them only catches a change written in them;</li>
 *   <li>`file`: the whole file's SHA-256, when it takes a reference to `strictly` (`this.&strictly`, `::strictly`):
 *       stored under another name, it could be called anywhere, so any change to such a file differs. Also used when
 *       the language's lexer finds a `strictly` identifier or string occurrence the visitor hasn't accounted for at
 *       that source position; counts cannot hide an unvisited occurrence behind a visited one.</li>
 * </ul>
 * Enclosing property assignments and Kotlin infix lambda scopes retain their target too. Groovy source columns
 * are code points, converted to UTF-16 only for slicing; Kotlin PSI offsets are already UTF-16.
 * Parameter defaults (methods, constructors and closures too) are visited. Lexer errors fail like parse errors.
 * A file that doesn't parse prints one `error` line with the first line of the reason, and the others are still read.
 */
public class StrictCalls {
  public static void main(String[] args) throws Exception {
    for (String file : args) {
      List<String[]> found;
      try {
        String text = Files.readString(Path.of(file));
        found = file.endsWith(".kt") || file.endsWith(".kts") ? kotlin(file, text) : groovy(file, text);
      } catch (Exception | StackOverflowError | org.apache.groovy.parser.antlr4.GroovySyntaxError err) {
        String reason = String.valueOf(err.getMessage()).lines().map(String::strip).filter(line -> !line.isBlank() && !line.equals("startup failed:")).findFirst().orElse(err.getClass().getSimpleName());
        if (err instanceof org.apache.groovy.parser.antlr4.GroovySyntaxError syntax) reason = file + ": " + syntax.getLine() + ": " + reason;
        found = List.<String[]>of(new String[] {"error", reason});
      }
      for (String[] finding : found) System.out.println(file + "\t" + finding[0] + "\t" + escape(finding[1]));
    }
  }

  /** A backslash and a newline both escape, so two different texts never print the same line. */
  static String escape(String text) {
    return text.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
  }

  static boolean names(String text) {
    return text != null && text.contains("strictly");
  }

  static String sha256(String text) {
    try {
      return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException err) {
      throw new IllegalStateException(err);
    }
  }

  // ---- Kotlin ----

  static List<String[]> kotlin(String file, String text) {
    var disposable = org.jetbrains.kotlin.com.intellij.openapi.util.Disposer.newDisposable();
    try {
      var configuration = new org.jetbrains.kotlin.config.CompilerConfiguration();
      configuration.put(org.jetbrains.kotlin.cli.common.CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, org.jetbrains.kotlin.cli.common.messages.MessageCollector.Companion.getNONE());
      var environment = org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment.createForProduction(disposable, configuration, org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles.JVM_CONFIG_FILES);
      var parsed = new org.jetbrains.kotlin.psi.KtPsiFactory(environment.getProject(), false).createFile(Path.of(file).getFileName().toString(), text);
      if (org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil.hasErrorElements(parsed)) throw new IllegalArgumentException("it doesn't parse as Kotlin");
      List<String[]> found = new ArrayList<>();
      Set<Integer> accounted = new HashSet<>();
      List<org.jetbrains.kotlin.com.intellij.openapi.util.TextRange> strings = new ArrayList<>();
      parsed.accept(new org.jetbrains.kotlin.psi.KtTreeVisitorVoid() {
        @Override public void visitCallExpression(org.jetbrains.kotlin.psi.KtCallExpression call) {
          var callee = call.getCalleeExpression();
          if (callee instanceof org.jetbrains.kotlin.psi.KtSimpleNameExpression simple && kotlinName(simple).equals("strictly")) {
            accounted.add(simple.getReferencedNameElement().getTextOffset());
            found.add(new String[] {"call", kotlinCall(call)});
          } else if (callee != null && !(callee instanceof org.jetbrains.kotlin.psi.KtSimpleNameExpression) && names(callee.getText())) {
            found.add(new String[] {"indirect", call.getText()});
          }
          super.visitCallExpression(call);
        }
        @Override public void visitCallableReferenceExpression(org.jetbrains.kotlin.psi.KtCallableReferenceExpression reference) {
          if (kotlinName(reference.getCallableReference()).equals("strictly")) {
            accounted.add(reference.getCallableReference().getReferencedNameElement().getTextOffset());
            wholeFile(found, text);
          }
          super.visitCallableReferenceExpression(reference);
        }
        @Override public void visitStringTemplateExpression(org.jetbrains.kotlin.psi.KtStringTemplateExpression string) {
          if (names(string.getText())) {
            strings.add(string.getTextRange());
            // As an argument, the call it's passed to: `invoke("strictly", "1.0")` keeps its other arguments.
            var call = org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil.getParentOfType(string, org.jetbrains.kotlin.psi.KtCallExpression.class);
            found.add(new String[] {"indirect", call == null ? string.getText() : call.getText()});
          }
          super.visitStringTemplateExpression(string);
        }
      });
      checkKotlinMentions(parsed, text, found, accounted, strings);
      return found;
    } finally {
      org.jetbrains.kotlin.com.intellij.openapi.util.Disposer.dispose(disposable);
    }
  }

  static void checkKotlinMentions(org.jetbrains.kotlin.psi.KtFile parsed, String text, List<String[]> found,
      Set<Integer> accounted, List<org.jetbrains.kotlin.com.intellij.openapi.util.TextRange> strings) {
    // PSI leaves use Kotlin's lexer, including backticked identifiers and string contents, never comments.
    parsed.accept(new org.jetbrains.kotlin.com.intellij.psi.PsiRecursiveElementWalkingVisitor() {
      @Override public void visitElement(org.jetbrains.kotlin.com.intellij.psi.PsiElement element) {
        if (element.getFirstChild() == null) {
          var type = element.getNode().getElementType();
          boolean identifier = type == org.jetbrains.kotlin.lexer.KtTokens.IDENTIFIER && element.getText().replace("`", "").equals("strictly");
          boolean stringContent = (type == org.jetbrains.kotlin.lexer.KtTokens.REGULAR_STRING_PART || type == org.jetbrains.kotlin.lexer.KtTokens.ESCAPE_SEQUENCE) && names(element.getText());
          int offset = element.getTextOffset();
          if ((identifier || stringContent) && !accounted.contains(offset) && strings.stream().noneMatch(range -> range.getStartOffset() <= offset && offset < range.getEndOffset())) wholeFile(found, text);
        }
        super.visitElement(element);
      }
    });
  }

  static String kotlinName(org.jetbrains.kotlin.psi.KtSimpleNameExpression name) {
    return name.getReferencedName().replace("`", "");
  }

  /** One whole-file finding even when several references or unaccounted occurrences require it. */
  static void wholeFile(List<String[]> found, String text) {
    if (found.stream().noneMatch(finding -> finding[0].equals("file"))) found.add(new String[] {"file", sha256(text)});
  }

  /** The call with its receiver (`a.strictly(...)`) and each enclosing call's name and non-lambda arguments. */
  static String kotlinCall(org.jetbrains.kotlin.psi.KtCallExpression call) {
    StringBuilder out = new StringBuilder();
    if (call.getParent() instanceof org.jetbrains.kotlin.psi.KtQualifiedExpression qualified && qualified.getSelectorExpression() == call) {
      out.append(qualified.getReceiverExpression().getText()).append(qualified.getOperationTokenNode().getText());
    }
    out.append(call.getText());
    for (var ancestor = call.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
      if (ancestor instanceof org.jetbrains.kotlin.psi.KtBinaryExpression binary && binary.getRight() instanceof org.jetbrains.kotlin.psi.KtLambdaExpression) {
        out.append(" | ").append(binary.getLeft() == null ? "" : binary.getLeft().getText()).append(' ').append(binary.getOperationReference().getText());
      }
      if (!(ancestor instanceof org.jetbrains.kotlin.psi.KtCallExpression outer)) continue;
      out.append(" | ");
      if (outer.getParent() instanceof org.jetbrains.kotlin.psi.KtQualifiedExpression qualified && qualified.getSelectorExpression() == outer) {
        out.append(qualified.getReceiverExpression().getText()).append(qualified.getOperationTokenNode().getText());
      }
      out.append(outer.getCalleeExpression() == null ? "" : outer.getCalleeExpression().getText());
      if (outer.getTypeArgumentList() != null) out.append(outer.getTypeArgumentList().getText());
      for (var argument : outer.getValueArguments()) {
        var expression = argument.getArgumentExpression();
        if (!(expression instanceof org.jetbrains.kotlin.psi.KtLambdaExpression)) out.append('(').append(expression == null ? "" : expression.getText()).append(')');
      }
    }
    return out.toString();
  }

  // ---- Groovy ----

  static List<String[]> groovy(String file, String text) {
    var unit = org.codehaus.groovy.control.SourceUnit.create(file, text);
    // Parse and convert only: the later compilation phases, where AST transformations run, never start.
    unit.parse();
    unit.completePhase();
    unit.nextPhase();
    unit.convert();
    var module = unit.getAST();
    String[] lines = text.split("\n", -1);
    List<String[]> found = new ArrayList<>();
    Set<Position> accounted = new HashSet<>();
    List<org.codehaus.groovy.ast.ASTNode> strings = new ArrayList<>();
    var visitor = new org.codehaus.groovy.ast.CodeVisitorSupport() {
      final Deque<String> enclosing = new ArrayDeque<>();
      @Override public void visitMethodCallExpression(org.codehaus.groovy.ast.expr.MethodCallExpression call) {
        String name = call.getMethodAsString();
        if ("strictly".equals(name)) {
          accounted.add(position(call.getMethod()));
          StringBuilder out = new StringBuilder(slice(lines, call));
          for (var outer : enclosing) out.append(" | ").append(outer);
          found.add(new String[] {"call", out.toString()});
        } else if (name == null) {
          // `"$name"(...)` or `"strictly"` built at run time: the call can't be named, so its text is compared.
          found.add(new String[] {"indirect", slice(lines, call)});
        }
        if (name != null && !"strictly".equals(name) && call.getArguments() instanceof org.codehaus.groovy.ast.expr.TupleExpression arguments
            && arguments.getExpressions().stream().anyMatch(argument -> names(argument.getText()) && !(argument instanceof org.codehaus.groovy.ast.expr.ClosureExpression))) {
          // `invokeMethod('strictly', ['1.0'])`: the whole call, so its other arguments are compared too.
          found.add(new String[] {"indirect", slice(lines, call)});
        }
        enclosing.push(callHeader(lines, call));
        super.visitMethodCallExpression(call);
        enclosing.pop();
      }
      @Override public void visitBinaryExpression(org.codehaus.groovy.ast.expr.BinaryExpression binary) {
        boolean closure = binary.getRightExpression() instanceof org.codehaus.groovy.ast.expr.ClosureExpression;
        if (closure) enclosing.push(slice(lines, binary.getLeftExpression()) + " " + binary.getOperation().getText());
        super.visitBinaryExpression(binary);
        if (closure) enclosing.pop();
      }
      @Override public void visitMethodPointerExpression(org.codehaus.groovy.ast.expr.MethodPointerExpression pointer) {
        if (names(pointer.getMethodName().getText())) {
          accounted.add(position(pointer.getMethodName()));
          wholeFile(found, text);
        }
        super.visitMethodPointerExpression(pointer);
      }
      @Override public void visitPropertyExpression(org.codehaus.groovy.ast.expr.PropertyExpression property) {
        if ("strictly".equals(property.getPropertyAsString())) {
          accounted.add(position(property.getProperty()));
          found.add(new String[] {"indirect", slice(lines, property)});
        }
        super.visitPropertyExpression(property);
      }
      @Override public void visitConstantExpression(org.codehaus.groovy.ast.expr.ConstantExpression constant) {
        if (constant.getValue() instanceof String string && names(string)) {
          accounted.add(position(constant));
          found.add(new String[] {"indirect", string});
        }
        super.visitConstantExpression(constant);
      }
      @Override public void visitClosureExpression(org.codehaus.groovy.ast.expr.ClosureExpression closure) {
        visitDefaults(closure.getParameters(), this);
        super.visitClosureExpression(closure);
      }
      @Override public void visitGStringExpression(org.codehaus.groovy.ast.expr.GStringExpression string) {
        if (names(string.getText())) {
          strings.add(string);
          found.add(new String[] {"indirect", slice(lines, string)});
        }
        super.visitGStringExpression(string);
      }
    };
    module.getStatementBlock().visit(visitor);
    for (var method : module.getMethods()) visitMethod(method, visitor);
    // The script's own classes: fields, methods, constructors and initializer blocks.
    for (var type : module.getClasses()) {
      if (type.isScript()) continue;
      for (var field : type.getFields()) if (field.hasInitialExpression()) field.getInitialExpression().visit(visitor);
      for (var method : type.getMethods()) visitMethod(method, visitor);
      for (var constructor : type.getDeclaredConstructors()) visitMethod(constructor, visitor);
      for (var initializer : type.getObjectInitializerStatements()) initializer.visit(visitor);
    }
    checkGroovyMentions(text, found, accounted, strings);
    return found;
  }

  static void checkGroovyMentions(String text, List<String[]> found, Set<Position> accounted, List<org.codehaus.groovy.ast.ASTNode> strings) {
    var lexer = new org.apache.groovy.parser.antlr4.GroovyLangLexer(groovyjarjarantlr4.v4.runtime.CharStreams.fromString(text));
    lexer.removeErrorListeners();
    lexer.addErrorListener(new groovyjarjarantlr4.v4.runtime.ANTLRErrorListener<Integer>() {
      @Override public <T extends Integer> void syntaxError(groovyjarjarantlr4.v4.runtime.Recognizer<T, ?> recognizer, T offending, int line, int column, String message, groovyjarjarantlr4.v4.runtime.RecognitionException error) {
        throw new IllegalArgumentException("Groovy lexer at " + line + ":" + (column + 1) + ": " + message);
      }
    });
    for (var token = lexer.nextToken(); token.getType() != groovyjarjarantlr4.v4.runtime.Token.EOF; token = lexer.nextToken()) {
      String kind = lexer.getVocabulary().getSymbolicName(token.getType());
      boolean mention = "Identifier".equals(kind) && token.getText().equals("strictly")
          || ("StringLiteral".equals(kind) || kind != null && kind.startsWith("GString")) && names(token.getText());
      var at = new Position(token.getLine(), token.getCharPositionInLine() + 1);
      if (mention && !accounted.contains(at) && strings.stream().noneMatch(node -> contains(node, at))) wholeFile(found, text);
    }
  }

  /** Groovy AST and ANTLR columns are both one-based code points, never UTF-16 offsets. */
  record Position(int line, int column) implements Comparable<Position> {
    @Override public int compareTo(Position other) {
      return line == other.line ? Integer.compare(column, other.column) : Integer.compare(line, other.line);
    }
  }

  static Position position(org.codehaus.groovy.ast.ASTNode node) {
    return new Position(node.getLineNumber(), node.getColumnNumber());
  }

  static boolean contains(org.codehaus.groovy.ast.ASTNode node, Position at) {
    return position(node).compareTo(at) <= 0 && at.compareTo(new Position(node.getLastLineNumber(), node.getLastColumnNumber())) < 0;
  }

  static void visitDefaults(org.codehaus.groovy.ast.Parameter[] parameters, org.codehaus.groovy.ast.CodeVisitorSupport visitor) {
    if (parameters == null) return; // A closure with an implicit `it` has no parameter array.
    for (var parameter : parameters) if (parameter.hasInitialExpression()) parameter.getInitialExpression().visit(visitor);
  }

  static void visitMethod(org.codehaus.groovy.ast.MethodNode method, org.codehaus.groovy.ast.CodeVisitorSupport visitor) {
    visitDefaults(method.getParameters(), visitor);
    if (method.getCode() != null) method.getCode().visit(visitor);
  }

  /** Full receiver and navigation operator, method name and non-closure arguments; closure bodies stay separate. */
  static String callHeader(String[] lines, org.codehaus.groovy.ast.expr.MethodCallExpression call) {
    StringBuilder out = new StringBuilder();
    if (!call.isImplicitThis()) {
      out.append(slice(lines, call.getObjectExpression())).append(call.isSpreadSafe() ? "*." : call.isSafe() ? "?." : ".");
    }
    if (call.getGenericsTypes() != null) {
      out.append('<');
      for (var type : call.getGenericsTypes()) out.append(slice(lines, type)).append(',');
      out.append('>');
    }
    return out.append(slice(lines, call.getMethod())).append(headerArguments(lines, call)).toString();
  }

  /** An enclosing call's non-closure arguments: where `implementation('g:a') {…}` names the dependency it pins. */
  static String headerArguments(String[] lines, org.codehaus.groovy.ast.expr.MethodCallExpression call) {
    StringBuilder out = new StringBuilder();
    if (call.getArguments() instanceof org.codehaus.groovy.ast.expr.TupleExpression arguments) {
      for (var argument : arguments.getExpressions()) {
        if (!(argument instanceof org.codehaus.groovy.ast.expr.ClosureExpression)) out.append('(').append(slice(lines, argument)).append(')');
      }
    }
    return out.toString();
  }

  /** Chained Groovy calls can start at their final method name; retain the receiver's earlier start as well. */
  static org.codehaus.groovy.ast.ASTNode sourceStart(org.codehaus.groovy.ast.ASTNode node) {
    org.codehaus.groovy.ast.ASTNode receiver = null;
    if (node instanceof org.codehaus.groovy.ast.expr.MethodCallExpression call && !call.isImplicitThis()) receiver = call.getObjectExpression();
    else if (node instanceof org.codehaus.groovy.ast.expr.PropertyExpression property) receiver = property.getObjectExpression();
    else if (node instanceof org.codehaus.groovy.ast.expr.BinaryExpression binary) receiver = binary.getLeftExpression();
    if (receiver == null || receiver.getLineNumber() < 1) return node;
    var start = sourceStart(receiver);
    return position(start).compareTo(position(node)) < 0 ? start : node;
  }

  /** The node's source text, from its first line and column to its last. */
  static String slice(String[] lines, org.codehaus.groovy.ast.ASTNode node) {
    if (node.getLineNumber() < 1) return node.getText();
    var start = sourceStart(node);
    StringBuilder out = new StringBuilder();
    for (int line = start.getLineNumber(); line <= node.getLastLineNumber(); line++) {
      String text = lines[line - 1];
      int points = text.codePointCount(0, text.length());
      int from = line == start.getLineNumber() ? start.getColumnNumber() - 1 : 0;
      int to = line == node.getLastLineNumber() ? Math.min(node.getLastColumnNumber() - 1, points) : points;
      out.append(text, text.offsetByCodePoints(0, from), text.offsetByCodePoints(0, to));
      if (line < node.getLastLineNumber()) out.append("\n");
    }
    return out.toString();
  }
}
