import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Lists what a Gradle build script says about strict versions, parsed (never run) with the compilers the build's own
 * Gradle distribution ships: Groovy's for `.gradle`, Kotlin's for `.gradle.kts`. Run with Java's source launcher:
 * `java -cp <the distribution's lib jars> StrictCalls.java <file>...`.
 *
 * <p>Prints one line per finding, `<file> TAB <kind> TAB <text>`, the text escaped so no two differ only by a newline:
 * <ul>
 *   <li>`call`: a direct `strictly(...)` call, with its receiver and every enclosing call's non-closure arguments (the
 *       dependency it pins, `implementation("g:a") { version { strictly("1.0") } }`);</li>
 *   <li>`indirect`: anything else that names `strictly`: a dynamic method name, a property, or a string holding the
 *       word, with the whole call it's an argument of (`invokeMethod('strictly', ['1.0'])`). They aren't followed, so
 *       comparing them only catches a change written in them;</li>
 *   <li>`file`: the whole file's SHA-256, when it takes a reference to `strictly` (`this.&strictly`, `::strictly`):
 *       stored under another name, it could be called anywhere, so any change to such a file differs.</li>
 * </ul>
 * A file that doesn't parse prints one `error` line with the first line of the reason, and the others are still read.
 */
public class StrictCalls {
  public static void main(String[] args) throws Exception {
    for (String file : args) {
      List<String[]> found;
      try {
        String text = Files.readString(Path.of(file));
        found = file.endsWith(".kts") ? kotlin(file, text) : groovy(file, text);
      } catch (Exception | StackOverflowError err) {
        String reason = String.valueOf(err.getMessage()).strip().lines().filter(line -> !line.isBlank()).findFirst().orElse(err.getClass().getSimpleName());
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
      parsed.accept(new org.jetbrains.kotlin.psi.KtTreeVisitorVoid() {
        @Override public void visitCallExpression(org.jetbrains.kotlin.psi.KtCallExpression call) {
          var callee = call.getCalleeExpression();
          if (callee instanceof org.jetbrains.kotlin.psi.KtSimpleNameExpression simple && simple.getReferencedName().equals("strictly")) {
            found.add(new String[] {"call", kotlinCall(call)});
          } else if (callee != null && !(callee instanceof org.jetbrains.kotlin.psi.KtSimpleNameExpression) && names(callee.getText())) {
            found.add(new String[] {"indirect", call.getText()});
          }
          super.visitCallExpression(call);
        }
        @Override public void visitCallableReferenceExpression(org.jetbrains.kotlin.psi.KtCallableReferenceExpression reference) {
          if (reference.getCallableReference().getReferencedName().equals("strictly")) found.add(new String[] {"file", sha256(text)});
          super.visitCallableReferenceExpression(reference);
        }
        @Override public void visitStringTemplateExpression(org.jetbrains.kotlin.psi.KtStringTemplateExpression string) {
          if (names(string.getText())) {
            // As an argument, the call it's passed to: `invoke("strictly", "1.0")` keeps its other arguments.
            var call = org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil.getParentOfType(string, org.jetbrains.kotlin.psi.KtCallExpression.class);
            found.add(new String[] {"indirect", call == null ? string.getText() : call.getText()});
          }
          super.visitStringTemplateExpression(string);
        }
      });
      return found;
    } finally {
      org.jetbrains.kotlin.com.intellij.openapi.util.Disposer.dispose(disposable);
    }
  }

  /** The call with its receiver (`a.strictly(...)`) and each enclosing call's name and non-lambda arguments. */
  static String kotlinCall(org.jetbrains.kotlin.psi.KtCallExpression call) {
    StringBuilder out = new StringBuilder();
    if (call.getParent() instanceof org.jetbrains.kotlin.psi.KtQualifiedExpression qualified && qualified.getSelectorExpression() == call) {
      out.append(qualified.getReceiverExpression().getText()).append('.');
    }
    out.append(call.getText());
    for (var ancestor = call.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
      if (!(ancestor instanceof org.jetbrains.kotlin.psi.KtCallExpression outer)) continue;
      out.append(" | ").append(outer.getCalleeExpression() == null ? "" : outer.getCalleeExpression().getText());
      for (var argument : outer.getValueArguments()) {
        var expression = argument.getArgumentExpression();
        if (!(expression instanceof org.jetbrains.kotlin.psi.KtLambdaExpression)) out.append('(').append(expression == null ? "" : expression.getText()).append(')');
      }
    }
    return out.toString();
  }

  // ---- Groovy ----

  static List<String[]> groovy(String file, String text) {
    var unit = org.codehaus.groovy.control.SourceUnit.create(Path.of(file).getFileName().toString(), text);
    // Parse and convert only: the later compilation phases, where AST transformations run, never start.
    unit.parse();
    unit.completePhase();
    unit.nextPhase();
    unit.convert();
    var module = unit.getAST();
    String[] lines = text.split("\n", -1);
    List<String[]> found = new ArrayList<>();
    var visitor = new org.codehaus.groovy.ast.CodeVisitorSupport() {
      final Deque<org.codehaus.groovy.ast.expr.MethodCallExpression> enclosing = new ArrayDeque<>();
      @Override public void visitMethodCallExpression(org.codehaus.groovy.ast.expr.MethodCallExpression call) {
        String name = call.getMethodAsString();
        if ("strictly".equals(name)) {
          StringBuilder out = new StringBuilder(slice(lines, call));
          for (var outer : enclosing) out.append(" | ").append(outer.getMethodAsString()).append(headerArguments(lines, outer));
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
        enclosing.push(call);
        super.visitMethodCallExpression(call);
        enclosing.pop();
      }
      @Override public void visitMethodPointerExpression(org.codehaus.groovy.ast.expr.MethodPointerExpression pointer) {
        if (names(pointer.getMethodName().getText())) found.add(new String[] {"file", sha256(text)});
        super.visitMethodPointerExpression(pointer);
      }
      @Override public void visitPropertyExpression(org.codehaus.groovy.ast.expr.PropertyExpression property) {
        if ("strictly".equals(property.getPropertyAsString())) found.add(new String[] {"indirect", slice(lines, property)});
        super.visitPropertyExpression(property);
      }
      @Override public void visitConstantExpression(org.codehaus.groovy.ast.expr.ConstantExpression constant) {
        if (constant.getValue() instanceof String string && names(string)) found.add(new String[] {"indirect", string});
        super.visitConstantExpression(constant);
      }
      @Override public void visitGStringExpression(org.codehaus.groovy.ast.expr.GStringExpression string) {
        if (names(string.getText())) found.add(new String[] {"indirect", slice(lines, string)});
        super.visitGStringExpression(string);
      }
    };
    module.getStatementBlock().visit(visitor);
    for (var method : module.getMethods()) method.getCode().visit(visitor);
    // The script's own classes: fields, methods, constructors and initializer blocks.
    for (var type : module.getClasses()) {
      if (type.isScript()) continue;
      for (var field : type.getFields()) if (field.hasInitialExpression()) field.getInitialExpression().visit(visitor);
      for (var method : type.getMethods()) if (method.getCode() != null) method.getCode().visit(visitor);
      for (var constructor : type.getDeclaredConstructors()) if (constructor.getCode() != null) constructor.getCode().visit(visitor);
      for (var initializer : type.getObjectInitializerStatements()) initializer.visit(visitor);
    }
    return found;
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

  /** The node's source text, from its first line and column to its last. */
  static String slice(String[] lines, org.codehaus.groovy.ast.ASTNode node) {
    if (node.getLineNumber() < 1) return node.getText();
    StringBuilder out = new StringBuilder();
    for (int line = node.getLineNumber(); line <= node.getLastLineNumber(); line++) {
      String text = lines[line - 1];
      int from = line == node.getLineNumber() ? node.getColumnNumber() - 1 : 0;
      int to = line == node.getLastLineNumber() ? node.getLastColumnNumber() - 1 : text.length();
      out.append(text, from, Math.min(to, text.length()));
      if (line < node.getLastLineNumber()) out.append("\n");
    }
    return out.toString();
  }
}
