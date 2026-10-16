import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Exercises unaccounted lexer input directly, independently of what the AST visitors already account for. */
public class StrictCallsSafetyNet {
  public static void main(String[] args) throws Exception {
    String text = Files.readString(Path.of(args[1]));
    List<String[]> found = new ArrayList<>();
    if (args[0].equals("groovy")) {
      StrictCalls.checkGroovyMentions(text, found, Set.of(), List.of());
    } else {
      var disposable = org.jetbrains.kotlin.com.intellij.openapi.util.Disposer.newDisposable();
      try {
        var configuration = new org.jetbrains.kotlin.config.CompilerConfiguration();
        configuration.put(org.jetbrains.kotlin.cli.common.CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, org.jetbrains.kotlin.cli.common.messages.MessageCollector.Companion.getNONE());
        var environment = org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment.createForProduction(disposable, configuration, org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles.JVM_CONFIG_FILES);
        var parsed = new org.jetbrains.kotlin.psi.KtPsiFactory(environment.getProject(), false).createFile("pins.kts", text);
        if (org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil.hasErrorElements(parsed)) throw new IllegalArgumentException("invalid test Kotlin");
        StrictCalls.checkKotlinMentions(parsed, text, found, Set.of(), List.of());
      } finally {
        org.jetbrains.kotlin.com.intellij.openapi.util.Disposer.dispose(disposable);
      }
    }
    for (var finding : found) System.out.println(finding[0] + "\t" + finding[1]);
  }
}
