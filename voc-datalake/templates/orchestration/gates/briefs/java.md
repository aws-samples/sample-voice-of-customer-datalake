# Agent brief (Java): set up and keep quality gates for dead code, duplication, "slop", memory and the JDK

> **Proven on 2026-09-25** on macOS (arm64) with Temurin 25.0.4.1, Maven 3.9.16 and Gradle 9.8.0, in throwaway repos built only from this file's blocks plus their own code: a two-module Maven build (a library, and an application using Jackson 3 and Mockito 5), the same code as a two-project Gradle build, and a single-module Maven library. `scripts/validate.sh` was green on all three, in one to two minutes each. All 40 plants of Phase 5 failed their gate with the message shown under Maven; under Gradle the Checkstyle, PMD, SpotBugs, NullAway, javac, CPD, dependency-analysis, version-conflict, thread-leak and skipped-test plants failed too. Three plants passed a green `mvn verify` and only this brief's scripts caught them: a test class Surefire never ran, a skipped test, and a suite that forced 12 full collections. The mutation report named the one surviving mutant on the changed lines under both build tools. The gaps those runs found are fixed below: PMD 7.28 retired or moved six rules; Temurin 25 ships without the jmods ProGuard normally reads; JFR's startup lines corrupted Surefire's channel; Error Prone skips anything named `unused…`; javac's lint warnings stop the compile before Error Prone runs; a library's only entry point is its API; Gradle's dependency analysis needs its settings plugin and `java-library` or `application`. Not exercised: the baselines of rule 1, Lombok and other annotation processors, Spring/JAX-RS keep rules, TestNG, a build JDK other than 25, and a CI matrix that also builds on older JDKs (Phase 2.9 says what to do; it was not run).
>
> **Proven again on 2026-09-25 on a real codebase**, [aws-powertools/powertools-lambda-java](https://github.com/aws-powertools/powertools-lambda-java) at `b583e7f`: 20 Maven modules, a Java 11 library with AspectJ weaving, CRaC, Mockito and JUnit 5, built with Temurin 25 and Maven 3.9.16 in Docker. Every phase was run in order and every Phase 5 row failed with its message. That run found the gaps fixed in this version: helpers that did not compile for `--release 11`; a `find | head -1` that killed `dead-code.sh` with SIGPIPE on Linux; a ProGuard test pass that failed whenever a test called a package-private member; scripts that could not run before the code was clean; `jdeps` stopping at the first modular jar; two modules whose own `<argLine>` silently ran their tests outside the bounded, recorded JVM; metaspace growth reported as a heap problem; a shared test-jar that shipped a module's own tests into every other module (PIT ran them there); a library keep rule that kept every public method of every `internal` package; and a data race no gate could see (Phase 2.10 adds one).

You are setting up a Java repository's quality gates from nothing, then fixing the code until every gate passes. After that, the gates keep the code in that shape. This file is self-contained: every config, script and helper you need is in it. Copy the blocks as written, change only the placeholders marked `<LIKE_THIS>`, and follow the phases in order. Blocks marked **[maven]** or **[gradle]** apply to that build tool only; everything else applies to both.

**What "slop" means here**, and the gate that catches each kind:

| Slop | Caught by |
| --- | --- |
| A class, method, field, parameter or dependency nothing uses | ProGuard reachability (`dead-code.sh`, production and test passes), Error Prone `UnusedVariable`/`UnusedMethod`, PMD `Unused*`, dependency analysis |
| Copy-pasted code, including a test that re-implements the code it tests | PMD CPD over production code **and** tests, every module, one run |
| An import that does not import | Checkstyle `UnusedImports`/`RedundantImport`/`AvoidStarImport` |
| Logic that says more than it does: a redundant cast, `if (x) return true; else return false;`, a collection built and never read, a null check on a value that cannot be null, boxing nobody needs | javac `-Xlint:all`, Error Prone `Unnecessary*`/`ModifiedButNotUsed`/`Redundant*`, PMD `Simplify*`/`Unnecessary*`/`Useless*`, SpotBugs `RCN_*`/`UC_*`/`DLS_*` |
| A type that lies: `null` where the signature promises a value, `map.get(k)` assumed present, `optional.get()` unguarded, raw types | NullAway (JSpecify `@Nullable`), `CheckOptionalEmptiness`, `-Xlint:rawtypes,unchecked` |
| A result nobody reads: an ignored `Future`, an unclosed stream or connection, a thread nobody stops | Error Prone `FutureReturnValueIgnored`/`ReturnValueIgnored`/`CheckReturnValue`/`MustBeClosedChecker`/`StreamResourceLeak`, PMD `CloseResource`, SpotBugs `OBL_*`/`OS_*`, the `NoThreadLeaks` extension |
| An error that disappears: an empty or over-broad `catch`, a swallowed `InterruptedException`, a lost cause | Error Prone `EmptyCatch`/`InterruptedExceptionSwallowed`/`UnusedException`/`CatchingUnchecked`, PMD `EmptyCatchBlock`/`AvoidCatchingGenericException`/`PreserveStackTrace` |
| Memory: a static collection that only grows, a `ThreadLocal` never removed, an inner class holding its outer instance, an object something keeps alive, hidden allocation on a hot path, a heap the tests outgrow | PMD `UnboundedStaticCollection`/`ThreadLocalWithoutRemove` (Phase 2.6), Error Prone `ClassCanBeStatic`/`NonFinalStaticField`/`ThreadLocalUsage`/`DoubleBraceInitialization`, SpotBugs `MS_*`, `Collectability`, `AllocationBudget`, `NoThreadLeaks`, the bounded test JVM, `JfrGate` |
| The JDK: a dependency built for a newer JDK than production runs, two versions of one library, the same class in two jars, a JDK-internal or removed API | `--release` with `-Werror`, the enforcer (`enforceBytecodeVersion`, `dependencyConvergence`, `banDuplicateClasses`), `jdk-report.sh` (jdeps, jdeprscan) for the dependencies |
| A test that does not test: asserts nothing, `assertThat(x)` with no check, skipped, never run, or passes whatever the code does | PMD `UnitTestShouldIncludeAssert`, Error Prone `CheckReturnValue`/`MissingFail`/`JUnit4TestNotRun`, `TestReports.java`, PIT on the changed lines |
| State shared between threads with no lock: a cache, a store or a map a parallel stream or an executor reaches | Error Prone `GuardedBy` (on by default) on fields annotated `@GuardedBy`, `Immutable` on types annotated `@Immutable`, and the shared-state rule of Phase 2.10 |
| A gate that did not look: a module whose tests ran outside the gated JVM, a test class never run | `JfrGate` ("test JVMs without a recording"), `TestReports.java`, the Phase 5 plants |
| A suppression that hides any of the above | Checkstyle bans `@SuppressWarnings`, `NOPMD`, `NOSONAR`, `CHECKSTYLE:OFF`, `noinspection`, `@SuppressFBWarnings` and a bare `CPD-OFF` |

---

## Ground rules (read twice)

1. **Zero is the gate.** A gate passes only when it has zero findings. Do not write per-area "debt ceiling" scripts. If a tree cannot reach zero in this change, use the tool's own baseline and never raise it: SpotBugs' baseline of today's findings (`excludeBugsFile` in Maven, `baselineFile` in Gradle), the Maven PMD plugin's `excludeFromFailureFile`, or `@NullUnmarked` on a package or class NullAway has not reached yet.
2. **Never suppress.** No `@SuppressWarnings` (javac, Error Prone, NullAway, PMD and Checkstyle all honour it), no `// NOPMD`, `NOSONAR`, `CHECKSTYLE:OFF`, `//noinspection`, `@SuppressFBWarnings`, no `-Xlint:-<key>` and no `-Xep:<Check>:OFF`. No name that starts with `unused` (Error Prone skips those). No `Objects.requireNonNull(x)`, `assert x != null` or `castToNonNull` whose only job is to quiet NullAway about a value that really can be `null`: that is Java's `!`. No raw type or unchecked cast to make a warning go away. Fix the code, or make the type tell the truth. The config bans the suppressions, so don't try to get around the ban.
3. **Measure before you enable.** Run each new rule once without failing, count its findings, and record the count (Phase 6 has the commands). Turn it into a failure in the same change that fixes them.
4. **Prove every gate looked.** A gate that scanned nothing also passes. For every gate, plant one violation, see the gate fail with the expected message, and revert it (Phase 5). Report the proof, with the scan counts each gate prints.
5. **Do not change behaviour.** This work changes structure, types and tests, not what the program does. If a fix would change behaviour (returning an unmodifiable list where callers mutate it, closing a resource a caller still uses, removing a reflective entry point), stop and report it instead. Do not delete a test to make a gate pass; fix the test. The production JVM's flags are behaviour too: measure them (Phase 3.8), report what you would change, change nothing.
6. **One phase per commit, with conventional messages** (`chore:`, `test:`, `docs:`). Commit only if the person who asked you allows it. Stage files by name, never `git add .`.
7. **Keep what the repo already enforces.** If a stricter existing rule conflicts with this brief, keep the stricter one. If the repo uses a different tool for the same job, this brief's tool replaces it only where it does more: SpotBugs replaces FindBugs, JSpecify's `@Nullable` replaces JSR-305's. Keep the repo's formatter (Spotless, google-java-format) for formatting only; nothing here formats.
8. **Say what you could not verify.** A green command is not proof unless you also proved it scanned something (rule 4).
9. **Measure in a scratch copy first.** On an existing codebase, run Phases 1 to 6 in a throwaway clone (`git clone --depth 1 <url> /tmp/<repo>-gates`) and hand back the report before you touch the real tree. The gates fail the build from the first commit (rule 1), and the person who asked decides which fixes change behaviour (rule 5).
10. **Every finding gets a tier.** The gate treats every finding the same way, but the report does not (see "Report"): a finding that can lose data or crash production comes before a naming rule.

---

## Phase 0: detect (read-only)

Run these commands and fill in the table below before you install anything.

```bash
git ls-files | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -20     # languages (Kotlin/Groovy/Scala are out of scope)
ls pom.xml mvnw .mvn/jvm.config .mvn/maven.config build.gradle build.gradle.kts settings.gradle settings.gradle.kts gradlew gradle/libs.versions.toml buildSrc build-logic .java-version .sdkmanrc .tool-versions 2>/dev/null
git ls-files | grep -E '(^|/)(pom\.xml|build\.gradle(\.kts)?)$'                                    # one per module
git ls-files | grep -E '(^|/)src/(main|test)/java/' | sed -E 's#^(.*/)?src/(main|test)/java/.*#\1 \2#' | sort | uniq -c   # sources per module
git grep -hoE 'import (static )?org\.(junit\.jupiter|junit|testng|assertj|hamcrest|mockito)\.[A-Za-z]+' -- '*.java' | sort | uniq -c | sort -rn | head   # test stack
git grep -lE '@(SpringBootApplication|Component|Service|Repository|RestController|Controller|Path|Entity|Inject|Singleton|QuarkusMain|JsonProperty)\b' -- '*.java' | head   # entry points by annotation, reflection
git grep -hE '<(maven\.compiler\.(release|source|target)|release|java\.version)>|languageVersion|sourceCompatibility|options\.release' -- '*pom.xml' '*.gradle*'   # the declared Java level
git grep -hoE 'FROM [^ ]+|-Xm[sx][0-9]+[kKmMgG]|-XX:[+-]?[A-Za-z]+(=[^ "]+)?|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|JAVA_OPTS|memory: *[0-9]+[A-Za-z]*' -- '*Dockerfile*' '*.yaml' '*.yml' '*.sh' '*.conf' '*.properties' | sort | uniq -c   # the production JVM
git ls-files | grep -iE '(checkstyle|pmd|spotbugs|findbugs|errorprone|nullaway|sonar|spotless|jacoco|lombok\.config)'
ls .github/workflows 2>/dev/null; java -version; ./mvnw -v 2>/dev/null | head -1; ./gradlew --version 2>/dev/null | grep -E '^Gradle'
git grep -hE 'java-version|jdk:' -- '.github/workflows/*' | sort | uniq -c                         # every JDK CI builds on
git grep -lE '<argLine>|jvmArgs' -- '*pom.xml' '*.gradle*'                                        # test JVM settings a module overrides
git grep -lE 'test-jar|java-test-fixtures' -- '*pom.xml' '*.gradle*'                              # test code already shared between modules
git grep -lE 'aspectj|@Aspect\b' -- '*pom.xml' '*.gradle*' '*.java' | head                         # AspectJ: a second compiler
git grep -lE 'getGlobalContext\(\)\.register|addShutdownHook|\.register\(this\)|addListener\(' -- '*.java' | head   # objects that register themselves
git grep -lE 'parallelStream\(\)|ExecutorService|CompletableFuture|ForkJoinPool' -- '*/src/main/*.java' | head   # code that runs on several threads
git ls-files | grep -E 'META-INF/services/|\.interceptors$|spring\.factories$|\.imports$' | head   # classes named in resource files
git ls-files | grep -E '\.(proto|avsc|avdl|graphqls|openapi\.ya?ml)$' | head                     # sources of generated code
```

| Question | Your answer | Consequence |
| --- | --- | --- |
| Build tool: Maven or Gradle; is there a wrapper? | | **[maven]** or **[gradle]** blocks; add the wrapper if missing (Phase 1) |
| Modules: every `pom.xml` / `build.gradle(.kts)` with `src/` | | gates go in the parent pom or a convention plugin; the test helpers live in one module (Phase 3.5) |
| Root package (`<ROOT_PKG>`, e.g. `com.acme`) | | NullAway's annotated code, PIT's targets, the helpers' package |
| Production JDK (`<JAVA_RELEASE>`, e.g. `21` or `25`) | | `javac --release`, PMD's language level, the dependencies' bytecode ceiling |
| Production JVM: GC, heap (`-Xmx` or `-XX:MaxRAMPercentage`), container memory and CPU limits | | the test JVM (Phase 3.1) and the container measurement (Phase 3.8) |
| Build JDK on this machine | | 25; Error Prone needs 21 or newer, and this brief was proven on 25 |
| Test stack: JUnit 5 or 6, JUnit 4 (vintage), TestNG; AssertJ, Hamcrest, Truth; Mockito | | JUnit 4 tests need the vintage engine or they never run; TestNG is out of scope |
| Frameworks: Spring, Quarkus, Micronaut, Jakarta EE, Jackson-mapped types | | entry points for `config/dead-code/keep.pro`; NullAway already skips `@Inject`/`@Autowired`/`@Mock` fields |
| Annotation processors: Lombok, MapStruct, Immutables, AutoValue | | **[maven]** list them in `annotationProcessorPaths` after NullAway (**[gradle]** `annotationProcessor(...)` as before); generated code is excluded |
| An application (a `main`, a framework's entry points) or a library (a published API)? | | the entry points in `config/dead-code/keep.pro` (Phase 2.8) |
| A command-line program that prints to stdout by design? | | drop Error Prone `SystemOut` and PMD `SystemPrintln`, each with a comment |
| Existing linters and configs to merge | | rule 7 |
| CI system | | CI calls `scripts/validate.sh`, nothing else |
| Hot paths (request handlers, parsers, batch loops) and objects that register themselves (listeners, sessions, caches, a CRaC/SnapStart `Resource`) | | allocation budgets and collectability tests (Phase 3.3, 3.4) |
| Every JDK CI builds on (a library often tests 11, 17, 21, 25) | | the gates run on the build JDK (25); the other jobs build without them (Phase 2.9) |
| Modules that set their own `<argLine>` / `jvmArgs` | | each one starts with `${gates.test.argLine}` (Phase 2.2), or its tests escape the bounded, recorded JVM |
| A module that already publishes a test-jar or test fixtures | | reuse it for the helpers and restrict what it ships (Phase 3.5) |
| AspectJ (`aspectj-maven-plugin`, `io.freefair.aspectj`) | | every module needs `aspectjrt`; ajc recompiles what javac and Error Prone checked (Phase 2.9) |
| Classes created by name from resource files (`META-INF/services`, AWS SDK `execution.interceptors`, `spring.factories`) | | `META-INF/services` is kept automatically; every other kind gets a keep rule (Phase 2.8) |
| Generated sources (protobuf, Avro, OpenAPI) | | excluded from PMD and kept whole by `dead-code.sh` |
| Objects shared between threads (a store or cache a parallel stream or executor reaches) | | `@GuardedBy`, a concurrent type, or `@Immutable` (Phase 2.10) |
| Serverless runtime (AWS Lambda, Cloud Run, Azure Functions) | | the production JVM is the platform's; measure it from its image (Phase 3.8) |

Pick the Java release from the runtime the code ships to (the Docker base image, such as `eclipse-temurin:21-jre`, or the platform's runtime), not from your shell. A library's release is the oldest JDK it supports (the lowest Lambda runtime it targets, for example), and every helper and script in this brief compiles for 11 or newer. Pick the test JVM's GC and heap from what production actually runs, which you measure in Phase 3.8 (AWS Lambda: Serial, a heap of about 85 % of the function's memory).

---

## Phase 1: install (pinned, dev-only)

These are the versions this setup was proven with. Everything is resolved by the build tool from exact versions; nothing is installed globally.

| Tool | Version | Gate |
| --- | --- | --- |
| JDK (build) | Temurin 25 | Error Prone must run on 21+; `--release` targets the production JDK |
| Maven (wrapper) | 3.9.16 | **[maven]** |
| Gradle (wrapper) | 9.8.0 | **[gradle]** |
| Error Prone | 2.50.0 | javac plugin: bug patterns, dead and unnecessary code, ignored results |
| NullAway | 0.14.2 | nullness, JSpecify mode |
| JSpecify | 1.0.1 | `@Nullable`, a compile dependency of every module that uses it |
| PMD, with CPD | 7.28.0 (maven-pmd-plugin 3.28.0) | dead code, logic, errors, leaks, tests; duplication |
| Checkstyle | 14.1.0 (maven-checkstyle-plugin 3.6.0) | suppression bans, imports, size |
| SpotBugs | 4.10.4 (spotbugs-maven-plugin 4.10.4.1), find-sec-bugs 1.14.0 | bytecode bug patterns, resources, security |
| maven-dependency-plugin | 3.11.0 | unused and undeclared dependencies |
| maven-enforcer-plugin | 3.6.3, extra-enforcer-rules 1.12.1 | JDK, pinned plugins, one version per library, duplicate classes, bytecode ceiling |
| PIT | 1.30.0, pitest-junit5-plugin 1.2.3 | mutation report on the changed lines |
| ProGuard | 7.10.0 | the dead-code passes |
| JUnit | 6.1.3 (BOM) | JUnit 6 needs Java 17: with `<JAVA_RELEASE>` below 17, or a JUnit 5 the repo already has, keep JUnit 5 (proven with 5.14): everything here works with both |
| AssertJ | 3.27.7 | assertions; Error Prone fails an `assertThat(x)` that checks nothing |
| Lifecycle plugins | compiler 3.16.0, surefire 3.6.0, clean 3.5.0, resources 3.5.0, jar 3.5.1, install 3.2.0, deploy 3.2.0, site 3.22.0 | **[maven]** pinned, because the enforcer bans unpinned plugins |
| Gradle plugins | `net.ltgt.errorprone` 5.1.1, `com.github.spotbugs` 6.5.11, `info.solidsoft.pitest` 1.19.0, `com.autonomousapps.build-health` 3.9.0; PMD CLI 7.28.0 for CPD | **[gradle]** Error Prone, SpotBugs, PIT, dependency analysis |

**[maven]** Pin the build with the wrapper (it creates `mvnw` and `.mvn/wrapper/maven-wrapper.properties`); every later command uses `./mvnw`:

```bash
mvn -N org.apache.maven.plugins:maven-wrapper-plugin:3.3.4:wrapper -Dmaven=3.9.16
```

**[gradle]** `gradle wrapper --gradle-version 9.8.0 --distribution-type bin`; every later command uses `./gradlew`.

Make sure `target/`, `build/`, `.gradle/` and `*.hprof` are in `.gitignore`.

---

## Phase 2: configuration

### 2.1 [maven] `.mvn/jvm.config`

Error Prone runs inside javac, inside Maven's JVM, and needs javac's internals opened (JEP 396). Add these lines; keep any the file already has.

```text
--add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.main=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.processing=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED
--add-exports jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED
--add-opens jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED
--add-opens jdk.compiler/com.sun.tools.javac.comp=ALL-UNNAMED
```

### 2.2 [maven] the root `pom.xml` (the parent of a multi-module build)

Merge each section into the root pom; keep its other content. Replace `<JAVA_RELEASE>` and `<ROOT_PKG>`. The plugins are bound to phases so that a plain `./mvnw verify` runs every per-module gate, cheapest first and tests last: `validate` (enforcer, Checkstyle, CPD over all modules), `compile` and `test-compile` (javac lint, Error Prone, NullAway), `process-test-classes` (PMD, SpotBugs, dependency analysis), then `test`.

```xml
  <properties>
    <!-- The JDK the code ships to (Phase 0): javac's release, PMD's language level, the dependencies' bytecode ceiling. -->
    <java.release><JAVA_RELEASE></java.release>
    <maven.compiler.release>${java.release}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    <!-- Your code's root package: NullAway checks it as annotated code, PIT mutates it and runs its tests. -->
    <gates.package><ROOT_PKG></gates.package>
    <!-- config/ at the top of the build, from any module (Maven sets the variable to the directory holding .mvn/). -->
    <gates.config>${maven.multiModuleProjectDirectory}/config</gates.config>
    <!-- Overridden only to measure (Phase 6): -Dgates.werror=-Xlint:all (a flag already given, in place of -Werror)
         -Dgates.nullaway=WARN -->
    <gates.werror>-Werror</gates.werror>
    <gates.nullaway>ERROR</gates.nullaway>
    <gates.errorprone.extra></gates.errorprone.extra>
    <!-- The test JVM (Phase 3.1): production's collector, a heap sized from a measurement and no larger than production's. -->
    <gates.test.heap>256m</gates.test.heap>
    <gates.test.metaspace>128m</gates.test.metaspace>
    <!-- G1 for a container with 2+ CPUs and 1792+ MB, Serial below that and on AWS Lambda (Phase 3.8 measures it). -->
    <gates.test.gc>-XX:+UseG1GC</gates.test.gc>
    <!-- JaCoCo prepends its agent to argLine, so the property must exist, even empty; a module using Mockito sets
         gates.test.agents (Phase 2.3). -->
    <argLine></argLine>
    <gates.test.agents></gates.test.agents>
    <!-- The test JVM, as one property: a module that needs its own <argLine> starts it with ${gates.test.argLine}, or
         its tests run outside the bounded, recorded JVM (JfrGate reports it as "test JVMs without a recording").
         MetaspaceSize is the bound too: the first full collection for class metadata happens only if the suite outgrows it. -->
    <gates.test.argLine>@{argLine} ${gates.test.agents} -Xmx${gates.test.heap} -XX:MetaspaceSize=${gates.test.metaspace} -XX:MaxMetaspaceSize=${gates.test.metaspace} ${gates.test.gc} -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=${project.build.directory} -XX:+ExitOnOutOfMemoryError -Xlog:jfr+startup=off -XX:StartFlightRecording=filename=${project.build.directory}/test-jvm-%p.jfr,settings=profile,dumponexit=true -Xlog:gc:file=${project.build.directory}/test-jvm-gc-%p.log</gates.test.argLine>
    <errorprone.version>2.50.0</errorprone.version>
    <nullaway.version>0.14.2</nullaway.version>
    <pmd.version>7.28.0</pmd.version>
    <checkstyle.version>14.1.0</checkstyle.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.junit</groupId>
        <artifactId>junit-bom</artifactId>
        <version>6.1.3</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <dependency>
        <groupId>org.jspecify</groupId>
        <artifactId>jspecify</artifactId>
        <version>1.0.1</version>
      </dependency>
      <!-- @GuardedBy and @Immutable for state shared between threads (Phase 2.10); Error Prone checks them. -->
      <dependency>
        <groupId>com.google.errorprone</groupId>
        <artifactId>error_prone_annotations</artifactId>
        <version>${errorprone.version}</version>
      </dependency>
      <dependency>
        <groupId>org.assertj</groupId>
        <artifactId>assertj-core</artifactId>
        <version>3.27.7</version>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <build>
    <pluginManagement>
      <plugins>
        <!-- Every plugin the lifecycle uses, pinned: the enforcer's requirePluginVersions fails an unpinned one. -->
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-clean-plugin</artifactId><version>3.5.0</version></plugin>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.5.0</version></plugin>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-jar-plugin</artifactId><version>3.5.1</version></plugin>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-install-plugin</artifactId><version>3.2.0</version></plugin>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-deploy-plugin</artifactId><version>3.2.0</version></plugin>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-site-plugin</artifactId><version>3.22.0</version></plugin>
        <!-- Mutation testing is a report (scripts/mutation-report.sh), not a lifecycle step. -->
        <plugin>
          <groupId>org.pitest</groupId>
          <artifactId>pitest-maven</artifactId>
          <version>1.30.0</version>
          <dependencies>
            <dependency>
              <groupId>org.pitest</groupId>
              <artifactId>pitest-junit5-plugin</artifactId>
              <version>1.2.3</version>
            </dependency>
          </dependencies>
          <configuration>
            <targetTests><param>${gates.package}.*</param></targetTests>
            <outputFormats><param>XML</param><param>HTML</param></outputFormats>
            <timestampedReports>false</timestampedReports>
            <failWhenNoMutations>false</failWhenNoMutations>
            <threads>4</threads>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>

    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-enforcer-plugin</artifactId>
        <version>3.6.3</version>
        <dependencies>
          <dependency>
            <groupId>org.codehaus.mojo</groupId>
            <artifactId>extra-enforcer-rules</artifactId>
            <version>1.12.1</version>
          </dependency>
        </dependencies>
        <executions>
          <execution>
            <id>gates-enforce</id>
            <goals><goal>enforce</goal></goals>
            <configuration>
              <rules>
                <!-- The build JDK this brief was proven on (Error Prone follows javac's internals), and the wrapper's Maven. -->
                <requireJavaVersion><version>[25,26)</version></requireJavaVersion>
                <requireMavenVersion><version>[3.9.16,4)</version></requireMavenVersion>
                <!-- A build that resolves "the latest" plugin is not reproducible. -->
                <requirePluginVersions>
                  <banLatest>true</banLatest>
                  <banRelease>true</banRelease>
                  <banSnapshots>true</banSnapshots>
                </requirePluginVersions>
                <!-- Two versions of one library on a compile or runtime classpath (test scope is not checked): one wins
                     silently, and the other's callers get NoSuchMethodError. -->
                <dependencyConvergence/>
                <banDuplicatePomDependencyVersions/>
                <!-- The same class in two jars: which one loads depends on classpath order. -->
                <banDuplicateClasses>
                  <findAllDuplicates>true</findAllDuplicates>
                  <ignoreWhenIdentical>true</ignoreWhenIdentical>
                </banDuplicateClasses>
                <!-- No runtime dependency built for a newer JDK than production runs: UnsupportedClassVersionError. -->
                <enforceBytecodeVersion>
                  <maxJdkVersion>${java.release}</maxJdkVersion>
                  <ignoredScopes><ignoredScope>test</ignoredScope></ignoredScopes>
                </enforceBytecodeVersion>
              </rules>
            </configuration>
          </execution>
        </executions>
      </plugin>

      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-checkstyle-plugin</artifactId>
        <version>3.6.0</version>
        <dependencies>
          <dependency>
            <groupId>com.puppycrawl.tools</groupId>
            <artifactId>checkstyle</artifactId>
            <version>${checkstyle.version}</version>
          </dependency>
        </dependencies>
        <configuration>
          <configLocation>${gates.config}/checkstyle/checkstyle.xml</configLocation>
          <includeTestSourceDirectory>true</includeTestSourceDirectory>
          <consoleOutput>true</consoleOutput>
          <violationSeverity>warning</violationSeverity>
          <failOnViolation>true</failOnViolation>
          <linkXRef>false</linkXRef>
        </configuration>
        <executions>
          <execution>
            <id>gates-checkstyle</id>
            <phase>validate</phase>
            <goals><goal>check</goal></goals>
          </execution>
        </executions>
      </plugin>

      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-pmd-plugin</artifactId>
        <version>3.28.0</version>
        <dependencies>
          <dependency><groupId>net.sourceforge.pmd</groupId><artifactId>pmd-core</artifactId><version>${pmd.version}</version></dependency>
          <dependency><groupId>net.sourceforge.pmd</groupId><artifactId>pmd-java</artifactId><version>${pmd.version}</version></dependency>
          <dependency><groupId>net.sourceforge.pmd</groupId><artifactId>pmd-javascript</artifactId><version>${pmd.version}</version></dependency>
          <dependency><groupId>net.sourceforge.pmd</groupId><artifactId>pmd-jsp</artifactId><version>${pmd.version}</version></dependency>
        </dependencies>
        <configuration>
          <targetJdk>${java.release}</targetJdk>
          <!-- Tests and production code in one run: a test that copies the logic it tests is a clone of it. -->
          <includeTests>true</includeTests>
          <rulesets><ruleset>${gates.config}/pmd/ruleset.xml</ruleset></rulesets>
          <printFailingErrors>true</printFailingErrors>
          <linkXRef>false</linkXRef>
          <analysisCache>true</analysisCache>
          <excludeRoots>
            <excludeRoot>${project.build.directory}/generated-sources</excludeRoot>
            <excludeRoot>${project.build.directory}/generated-test-sources</excludeRoot>
          </excludeRoots>
          <!-- CPD: a clone is 50 tokens (about ten lines of Java); annotation lists are not logic. Comments are never tokens. -->
          <minimumTokens>50</minimumTokens>
          <ignoreAnnotations>true</ignoreAnnotations>
        </configuration>
        <executions>
          <execution>
            <id>gates-pmd</id>
            <phase>process-test-classes</phase>
            <goals><goal>check</goal></goals>
          </execution>
          <!-- One CPD run over every module, from the root: a copy between two modules is still a copy. -->
          <execution>
            <id>gates-cpd</id>
            <phase>validate</phase>
            <goals><goal>aggregate-cpd-check</goal></goals>
            <inherited>false</inherited>
          </execution>
        </executions>
      </plugin>

      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.16.0</version>
        <configuration>
          <release>${java.release}</release>
          <showWarnings>true</showWarnings>
          <compilerArgs>
            <!-- Every javac lint, and a warning fails the build; print every finding, not javac's first 100. -->
            <arg>-Xlint:all</arg>
            <arg>${gates.werror}</arg>
            <arg>-Xmaxerrs</arg>
            <arg>10000</arg>
            <arg>-Xmaxwarns</arg>
            <arg>10000</arg>
            <arg>-XDcompilePolicy=simple</arg>
            <arg>--should-stop=ifError=FLOW</arg>
            <arg>-Xplugin:ErrorProne
              -XepDisableWarningsInGeneratedCode
              -XepExcludedPaths:.*/target/generated-(test-)?sources/.*
              -Xep:NullAway:${gates.nullaway}
              -XepOpt:NullAway:AnnotatedPackages=${gates.package}
              -XepOpt:NullAway:JSpecifyMode=true
              -XepOpt:NullAway:CheckOptionalEmptiness=true
              -XepOpt:NullAway:HandleTestAssertionLibraries=true
              -Xep:UnusedException:ERROR
              -Xep:InterruptedExceptionSwallowed:ERROR
              -Xep:CatchingUnchecked:ERROR
              -Xep:ThrowSpecificExceptions:ERROR
              -Xep:NonFinalStaticField:ERROR
              -Xep:SystemOut:ERROR
              -Xep:SystemExitOutsideMain:ERROR
              -Xep:UnnecessaryAnonymousClass:ERROR
              -Xep:UnnecessaryBoxedVariable:ERROR
              -Xep:UnnecessaryBoxedAssignment:ERROR
              -Xep:UnnecessaryDefaultInEnumSwitch:ERROR
              -Xep:UnnecessarilyFullyQualified:ERROR
              -Xep:UnnecessaryOptionalGet:ERROR
              -Xep:RedundantOverride:ERROR
              -Xep:RedundantThrows:ERROR
              -Xep:TimeUnitMismatch:ERROR
              ${gates.errorprone.extra}</arg>
          </compilerArgs>
          <annotationProcessorPaths>
            <path>
              <groupId>com.google.errorprone</groupId>
              <artifactId>error_prone_core</artifactId>
              <version>${errorprone.version}</version>
            </path>
            <path>
              <groupId>com.uber.nullaway</groupId>
              <artifactId>nullaway</artifactId>
              <version>${nullaway.version}</version>
            </path>
            <!-- Other annotation processors (Lombok, MapStruct...) go here, with their versions. -->
          </annotationProcessorPaths>
        </configuration>
      </plugin>

      <plugin>
        <groupId>com.github.spotbugs</groupId>
        <artifactId>spotbugs-maven-plugin</artifactId>
        <version>4.10.4.1</version>
        <configuration>
          <effort>Max</effort>
          <threshold>Low</threshold>
          <failThreshold>Low</failThreshold>
          <includeTests>false</includeTests>
          <excludeFilterFile>${gates.config}/spotbugs/exclude.xml</excludeFilterFile>
          <plugins>
            <plugin>
              <groupId>com.h3xstream.findsecbugs</groupId>
              <artifactId>findsecbugs-plugin</artifactId>
              <version>1.14.0</version>
            </plugin>
          </plugins>
        </configuration>
        <executions>
          <execution>
            <id>gates-spotbugs</id>
            <phase>process-test-classes</phase>
            <goals><goal>check</goal></goals>
          </execution>
        </executions>
      </plugin>

      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-dependency-plugin</artifactId>
        <version>3.11.0</version>
        <configuration>
          <!-- Runtime-scoped dependencies (a JDBC driver, a logging backend) are found by name at run time, by design. -->
          <ignoreUnusedRuntime>true</ignoreUnusedRuntime>
          <ignoredUnusedDeclaredDependencies>
            <!-- The JUnit Platform launcher finds the engine at run time; no test class references it. -->
            <ignoredUnusedDeclaredDependency>org.junit.jupiter:junit-jupiter-engine</ignoredUnusedDeclaredDependency>
          </ignoredUnusedDeclaredDependencies>
        </configuration>
        <executions>
          <execution>
            <id>gates-dependencies</id>
            <phase>process-test-classes</phase>
            <goals><goal>analyze-only</goal></goals>
            <configuration>
              <failOnWarning>true</failOnWarning>
            </configuration>
          </execution>
        </executions>
      </plugin>

      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.6.0</version>
        <configuration>
          <!-- One JVM per module for its whole suite: a leak across tests accumulates in it, and one recording sees all of it. -->
          <forkCount>1</forkCount>
          <reuseForks>true</reuseForks>
          <trimStackTrace>false</trimStackTrace>
          <!-- Phase 3.1: bounded heap and metaspace, production's collector, a heap dump and a hard stop on OutOfMemoryError,
               a JFR recording and a GC log per test JVM (%p is the JVM's pid). -->
          <argLine>${gates.test.argLine}</argLine>
          <properties>
            <!-- JUnit loads the extensions listed in META-INF/services: NoThreadLeaks runs for every test class (Phase 3.2). -->
            <configurationParameters>junit.jupiter.extensions.autodetection.enabled = true</configurationParameters>
          </properties>
        </configuration>
      </plugin>
    </plugins>
  </build>
```

Why these Error Prone checks: everything Error Prone enables by default is on, and `-Werror` turns each of its warnings into a failure. The `-Xep:…:ERROR` lines add checks that are off by default and catch slop: a caught exception thrown away when a new one is thrown (`UnusedException`), a swallowed interrupt, `catch (Exception e)` where only unchecked exceptions can occur, `throw new RuntimeException(…)`, mutable static state, printing instead of logging, `System.exit` in library code, boxing nobody needs, and overrides or `throws` clauses that change nothing. An unknown check name fails the build, so a typo cannot silently disable a line.

### 2.3 [maven] every module's `pom.xml`

The root manages versions; each module declares what it uses, so dependency analysis can tell an unused dependency from a used one. In a single-module build this is the same pom.

```xml
  <dependencies>
    <dependency>
      <groupId>org.jspecify</groupId>
      <artifactId>jspecify</artifactId>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-api</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter-engine</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.assertj</groupId>
      <artifactId>assertj-core</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
```

Declare `jspecify` only in modules that use `@Nullable`, and the test dependencies only in modules with tests: the analysis fails a declared dependency that nothing uses. It also fails a class used through a transitive dependency ("Used undeclared"): declare that dependency directly. A Spring Boot starter is a list of dependencies, not code: declare what you use from it, and add the starter to that module's `ignoredUnusedDeclaredDependencies` with a comment (`combine.children="append"` keeps the root's entries, as in Phase 3.5).

If a module uses Mockito 5, load Mockito as an agent: its inline mock maker otherwise attaches itself at run time, which JDK 21+ warns about and a future JDK will refuse (JEP 451). In that module's pom:

```xml
  <properties>
    <gates.test.agents>-javaagent:${org.mockito:mockito-core:jar}</gates.test.agents>
  </properties>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-dependency-plugin</artifactId>
        <executions>
          <!-- Sets ${org.mockito:mockito-core:jar} to the jar's path, for the agent above. -->
          <execution>
            <id>gates-agent-paths</id>
            <goals><goal>properties</goal></goals>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
```

### 2.4 [gradle] a convention plugin every Java project applies

The same gates as the Maven build, in one precompiled script plugin under `buildSrc` (merge into `build-logic` if the repo has one). Every Java project applies it with `plugins { id("quality-gates") }`. The root project adds duplication, dependency analysis and the classpath of ProGuard. The tool configs of 2.5–2.8 are shared with Maven.

`gradle.properties` (root; merge):

```properties
# The JDK the code ships to (Phase 0), and your code's root package.
gates.javaRelease=<JAVA_RELEASE>
gates.package=<ROOT_PKG>
# The test JVM (Phase 3.1): production's collector, a heap sized from a measurement and no larger than production's.
gates.test.heap=256m
gates.test.metaspace=128m
gates.test.gc=-XX:+UseG1GC
```

`buildSrc/build.gradle.kts`:

```kotlin
plugins {
    `kotlin-dsl`
}

repositories {
    gradlePluginPortal()
}

dependencies {
    implementation("net.ltgt.errorprone:net.ltgt.errorprone.gradle.plugin:5.1.1")
    implementation("com.github.spotbugs:com.github.spotbugs.gradle.plugin:6.5.11")
    implementation("info.solidsoft.pitest:info.solidsoft.pitest.gradle.plugin:1.19.0")
}
```

`buildSrc/src/main/kotlin/quality-gates.gradle.kts`:

```kotlin
// The quality gates for every Java project that applies id("quality-gates"). Measuring run (Phase 6): -Pgates.measure=true
import com.github.spotbugs.snom.Confidence
import com.github.spotbugs.snom.Effort
import com.github.spotbugs.snom.SpotBugsTask
import net.ltgt.gradle.errorprone.CheckSeverity
import net.ltgt.gradle.errorprone.errorprone

plugins {
    java
    checkstyle
    pmd
    id("net.ltgt.errorprone")
    id("com.github.spotbugs")
    id("info.solidsoft.pitest")
}

val javaRelease = providers.gradleProperty("gates.javaRelease").get().toInt()
val gatesPackage = providers.gradleProperty("gates.package").get()
val measuring = providers.gradleProperty("gates.measure").getOrElse("false").toBoolean()
val gatesConfig = rootProject.layout.projectDirectory.dir("config")

// The build JDK this brief was proven on: Error Prone follows javac's internals.
check(JavaVersion.current().majorVersion == "25") { "Build with JDK 25, not ${JavaVersion.current()}" }

dependencies {
    errorprone("com.google.errorprone:error_prone_core:2.50.0")
    errorprone("com.uber.nullaway:nullaway:0.14.2")
    spotbugsPlugins("com.h3xstream.findsecbugs:findsecbugs-plugin:1.14.0")
}

// Two versions of one library on a production classpath: fail, instead of silently taking the newest (NoSuchMethodError
// at runtime). Like Maven's dependencyConvergence, test classpaths are not checked.
listOf("compileClasspath", "runtimeClasspath").forEach { name ->
    configurations.named(name) { resolutionStrategy.failOnVersionConflict() }
}

tasks.withType<JavaCompile>().configureEach {
    options.release = javaRelease
    options.encoding = "UTF-8"
    // Every javac lint, and a warning fails the build; print every finding, not javac's first 100.
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Xmaxerrs", "10000", "-Xmaxwarns", "10000"))
    if (!measuring) {
        options.compilerArgs.add("-Werror")
    }
    options.errorprone {
        disableWarningsInGeneratedCode = true
        excludedPaths = ".*/build/generated/.*"
        allErrorsAsWarnings = measuring
        check("NullAway", if (measuring) CheckSeverity.WARN else CheckSeverity.ERROR)
        option("NullAway:AnnotatedPackages", gatesPackage)
        option("NullAway:JSpecifyMode", "true")
        option("NullAway:CheckOptionalEmptiness", "true")
        option("NullAway:HandleTestAssertionLibraries", "true")
        error(
            "UnusedException", "InterruptedExceptionSwallowed", "CatchingUnchecked", "ThrowSpecificExceptions",
            "NonFinalStaticField", "SystemOut", "SystemExitOutsideMain", "UnnecessaryAnonymousClass",
            "UnnecessaryBoxedVariable", "UnnecessaryBoxedAssignment", "UnnecessaryDefaultInEnumSwitch",
            "UnnecessarilyFullyQualified", "UnnecessaryOptionalGet", "RedundantOverride", "RedundantThrows",
            "TimeUnitMismatch",
        )
        // Patch mode (Phase 6): -Pgates.errorprone.extra="-XepPatchChecks:... -XepPatchLocation:IN_PLACE"
        errorproneArgs.addAll(providers.gradleProperty("gates.errorprone.extra").map { it.split(" ") }.getOrElse(listOf()))
    }
}

checkstyle {
    toolVersion = "14.1.0"
    configFile = gatesConfig.file("checkstyle/checkstyle.xml").asFile
    maxWarnings = 0
    isIgnoreFailures = measuring
}

pmd {
    toolVersion = "7.28.0"
    ruleSetFiles = files(gatesConfig.file("pmd/ruleset.xml"))
    ruleSets = listOf()
    isConsoleOutput = true
    isIgnoreFailures = measuring
}

spotbugs {
    toolVersion = "4.10.4"
    effort = Effort.MAX
    reportLevel = Confidence.LOW
    excludeFilter = gatesConfig.file("spotbugs/exclude.xml").asFile
    ignoreFailures = measuring
}

// Production code only: tests may request a collection (Collectability) and hold what they like.
tasks.withType<SpotBugsTask>().configureEach {
    enabled = name == "spotbugsMain"
    reports.create("xml") { required = true }
}

pitest {
    pitestVersion = "1.30.0"
    junit5PluginVersion = "1.2.3"
    targetClasses = providers.gradleProperty("gates.targetClasses").map { it.split(",").toSet() }.orElse(setOf("$gatesPackage.*"))
    targetTests = setOf("$gatesPackage.*")
    outputFormats = setOf("XML", "HTML")
    timestampedReports = false
    failWhenNoMutations = false
    threads = 4
}

// Phase 3.1: one JVM per project for its whole suite, bounded, production's collector, a heap dump and a hard stop
// on OutOfMemoryError, a JFR recording and a GC log (%p is the JVM's pid).
tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    maxHeapSize = providers.gradleProperty("gates.test.heap").get()
    val out = layout.buildDirectory.get().asFile.absolutePath
    jvmArgs(
        "-XX:MetaspaceSize=" + providers.gradleProperty("gates.test.metaspace").get(),
        "-XX:MaxMetaspaceSize=" + providers.gradleProperty("gates.test.metaspace").get(),
        providers.gradleProperty("gates.test.gc").get(),
        "-XX:+HeapDumpOnOutOfMemoryError", "-XX:HeapDumpPath=$out", "-XX:+ExitOnOutOfMemoryError",
        "-Xlog:jfr+startup=off", "-XX:StartFlightRecording=filename=$out/test-jvm-%p.jfr,settings=profile,dumponexit=true",
        "-Xlog:gc:file=$out/test-jvm-gc-%p.log",
    )
    // JUnit loads the extensions listed in META-INF/services: NoThreadLeaks runs for every test class (Phase 3.2).
    systemProperty("junit.jupiter.extensions.autodetection.enabled", "true")
}

// scripts/bytecode-inputs.sh reads these: each kind's class directories and the classpath they were compiled against.
val gatesSourceSets = the<SourceSetContainer>()
tasks.register("gatesClasspath") {
    val sets = gatesSourceSets
    val testSets = listOf("test", "testFixtures").mapNotNull { sets.findByName(it) }
    val mainDirs = sets["main"].output.classesDirs
    val mainClasspath = sets["main"].compileClasspath
    val testDirs = files(testSets.map { it.output.classesDirs })
    val testClasspath = files(testSets.map { it.compileClasspath })
    val out = layout.buildDirectory.dir("gates")
    dependsOn(mainDirs, testDirs)
    doLast {
        val dir = out.get().asFile
        dir.mkdirs()
        dir.resolve("main.dirs").writeText(mainDirs.files.joinToString("\n"))
        dir.resolve("main.classpath").writeText(mainClasspath.files.joinToString(File.pathSeparator))
        dir.resolve("test.dirs").writeText(testDirs.files.joinToString("\n"))
        dir.resolve("test.classpath").writeText(testClasspath.files.joinToString(File.pathSeparator))
    }
}
```

Gradle 9.8 prints one deprecation from these plugins (`Configuration.setVisible`, called by the PIT plugin, to be removed in Gradle 11): nothing in the build to fix. Run with `--warning-mode all` once to confirm the build scripts themselves add none.

`settings.gradle.kts` (merge): the dependency analysis, applied to every project.

```kotlin
plugins {
    id("com.autonomousapps.build-health") version "3.9.0"
}
```

The root `build.gradle.kts` (merge): CPD over every project in one run, the dependency analysis' failure condition, and ProGuard's classpath.

```kotlin
plugins {
    base
}

val measuring = providers.gradleProperty("gates.measure").getOrElse("false").toBoolean()

// Unused and undeclared dependencies, in every project: ./gradlew buildHealth
dependencyAnalysis {
    reporting {
        printBuildHealth(true)
    }
    issues {
        all {
            onAny { severity(if (measuring) "warn" else "fail") }
        }
    }
}

val cpd = configurations.create("cpd")
val proguard = configurations.create("proguard")
dependencies {
    cpd("net.sourceforge.pmd:pmd-cli:7.28.0")
    cpd("net.sourceforge.pmd:pmd-java:7.28.0")
    proguard("com.guardsquare:proguard-base:7.10.0")
}

// One CPD run over production code and tests of every project: a copy between two projects is still a copy.
val cpdCheck = tasks.register<JavaExec>("cpdCheck") {
    group = "verification"
    classpath = cpd
    mainClass = "net.sourceforge.pmd.cli.PmdCli"
    val roots = subprojects.flatMap { p -> listOf("main", "test", "testFixtures").map { p.file("src/$it/java") } }.filter { it.isDirectory }
    args(listOf("cpd", "--language", "java", "--minimum-tokens", "50", "--ignore-annotations", "--format", "text"))
    args(roots.flatMap { listOf("--dir", it.path) })
    if (measuring) {
        args("--no-fail-on-violation")
    }
}
tasks.named("check") { dependsOn(cpdCheck) }

// scripts/bytecode-inputs.sh: ./gradlew gatesProguardClasspath -Pgates.out=<file>
tasks.register("gatesProguardClasspath") {
    val classpath = proguard
    val out = providers.gradleProperty("gates.out")
    doLast { File(out.get()).apply { parentFile.mkdirs() }.writeText(classpath.asPath) }
}
```

Each Java project's `build.gradle.kts` applies the plugin next to `java-library` or `application`, whichever the project is (the dependency analysis skips a project with only `java`), and declares what it uses; a Gradle 9 build declares the JUnit launcher itself:

```kotlin
plugins {
    id("quality-gates")
    `java-library`
}

dependencies {
    compileOnly("org.jspecify:jspecify:1.0.1")
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter-api")
    testImplementation("org.assertj:assertj-core:3.27.7")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
```

A project that uses Mockito loads it as an agent (JEP 451), in its own build file:

```kotlin
val mockitoAgent = configurations.create("mockitoAgent")
dependencies {
    testImplementation("org.mockito:mockito-core:5.24.0")
    mockitoAgent("org.mockito:mockito-core:5.24.0") { isTransitive = false }
}
tasks.test {
    jvmArgs("-javaagent:${mockitoAgent.asPath}")
}
```

### 2.5 `config/checkstyle/checkstyle.xml`

Checkstyle bans the suppressions, checks imports, and holds the size limits. It formats nothing and checks no style: that is the formatter's job.

```xml
<?xml version="1.0"?>
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">
<!-- Suppression bans, imports that do not import, and size limits. -->
<module name="Checker">
  <property name="severity" value="error"/>
  <property name="fileExtensions" value="java"/>

  <!-- Split a file before it reaches its limit. Two limits, chosen by directory: these filters pick which
       limit applies to a file; they silence nothing else. -->
  <module name="FileLength">
    <property name="id" value="FileLengthMain"/>
    <property name="max" value="500"/>
  </module>
  <module name="FileLength">
    <property name="id" value="FileLengthTest"/>
    <property name="max" value="900"/>
  </module>
  <module name="SuppressionSingleFilter">
    <property name="id" value="FileLengthMain"/>
    <property name="files" value="[\\/]src[\\/]test[\\/]"/>
  </module>
  <module name="SuppressionSingleFilter">
    <property name="id" value="FileLengthTest"/>
    <property name="files" value="[\\/]src[\\/]main[\\/]"/>
  </module>

  <module name="TreeWalker">
    <!-- No suppressions: fix the finding. -->
    <module name="SuppressWarnings">
      <property name="format" value="^.*$"/>
    </module>
    <module name="RegexpSinglelineJava">
      <property name="id" value="SuppressionMarker"/>
      <property name="format" value="NOPMD|NOSONAR|CHECKSTYLE:(OFF|ON)|noinspection|SuppressFBWarnings|CPD-OFF\s*(\*/)?\s*$"/>
      <property name="message" value="Suppression marker: fix the finding. A duplicate kept on purpose says why: // CPD-OFF kept pair: the reason"/>
    </module>
    <!-- Error Prone does not report an unused method, field, parameter or variable whose name starts with "unused":
         a name is not a reason. Otherwise these are Checkstyle's default name formats, with _ allowed. -->
    <module name="MethodName">
      <property name="format" value="^(?!unused)[a-z][a-zA-Z0-9_]*$"/>
    </module>
    <module name="MemberName">
      <property name="format" value="^(?!unused)[a-z][a-zA-Z0-9_]*$"/>
    </module>
    <module name="ParameterName">
      <property name="format" value="^(_|(?!unused)[a-z][a-zA-Z0-9_]*)$"/>
    </module>
    <module name="LambdaParameterName">
      <property name="format" value="^(_|(?!unused)[a-z][a-zA-Z0-9_]*)$"/>
    </module>
    <module name="LocalVariableName">
      <property name="format" value="^(_|(?!unused)[a-z][a-zA-Z0-9_]*)$"/>
    </module>

    <!-- Imports that do not import; sun.* and jdk.internal.* are JDK internals that break on upgrade. -->
    <module name="UnusedImports"/>
    <module name="RedundantImport"/>
    <module name="AvoidStarImport"/>
    <module name="IllegalImport">
      <property name="illegalPkgs" value="sun, jdk.internal, com.sun.org.apache"/>
    </module>

    <!-- Size and shape. -->
    <module name="CyclomaticComplexity">
      <property name="max" value="12"/>
      <property name="switchBlockAsSingleDecisionPoint" value="true"/>
    </module>
    <module name="NestedIfDepth">
      <property name="max" value="2"/>
    </module>
    <module name="NestedForDepth">
      <property name="max" value="2"/>
    </module>
    <module name="NestedTryDepth">
      <property name="max" value="1"/>
    </module>
    <module name="MethodLength">
      <property name="max" value="60"/>
      <property name="countEmpty" value="false"/>
    </module>
    <module name="ParameterNumber">
      <property name="max" value="7"/>
      <property name="ignoreOverriddenMethods" value="true"/>
    </module>
  </module>
</module>
```

### 2.6 `config/pmd/ruleset.xml`

Each rule is here for one kind of slop; none is here for style. The two custom rules at the end are Java's classic leaks: a static collection lives as long as its class loader, and a `ThreadLocal` value lives as long as its thread, which for a pooled thread is forever.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ruleset name="quality-gates"
    xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">
  <description>Dead code, logic that says more than it does, errors that disappear, leaks, and tests that do not test.</description>
  <exclude-pattern>.*/generated-(test-)?sources/.*</exclude-pattern>
  <exclude-pattern>.*/build/generated/.*</exclude-pattern>

  <!-- dead code -->
  <rule ref="category/java/bestpractices.xml/UnusedPrivateMethod"/>
  <rule ref="category/java/bestpractices.xml/UnusedPrivateField"/>
  <rule ref="category/java/bestpractices.xml/UnusedLocalVariable"/>
  <rule ref="category/java/bestpractices.xml/UnusedFormalParameter"/>
  <rule ref="category/java/bestpractices.xml/UnusedAssignment"/>

  <!-- logic that says more than it does -->
  <rule ref="category/java/design.xml/SimplifyBooleanReturns"/>
  <rule ref="category/java/design.xml/SimplifyBooleanExpressions"/>
  <rule ref="category/java/design.xml/SimplifiedTernary"/>
  <rule ref="category/java/design.xml/SimplifyConditional"/>
  <rule ref="category/java/design.xml/CollapsibleIfStatements"/>
  <rule ref="category/java/design.xml/UselessOverridingMethod"/>
  <rule ref="category/java/codestyle.xml/VariableCanBeInlined"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryBoxing"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryCast"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryFullyQualifiedName"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryModifier"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryReturn"/>
  <rule ref="category/java/codestyle.xml/UnnecessaryConstructor"/>
  <rule ref="category/java/codestyle.xml/UnnecessarySemicolon"/>
  <rule ref="category/java/codestyle.xml/UselessQualifiedThis"/>
  <rule ref="category/java/codestyle.xml/EmptyControlStatement"/>
  <rule ref="category/java/codestyle.xml/IdenticalCatchBranches"/>
  <rule ref="category/java/bestpractices.xml/UseCollectionIsEmpty"/>
  <rule ref="category/java/bestpractices.xml/PrimitiveWrapperInstantiation"/>
  <rule ref="category/java/bestpractices.xml/ForLoopCanBeForeach"/>
  <rule ref="category/java/bestpractices.xml/UnnecessaryVarargsArrayCreation"/>
  <rule ref="category/java/errorprone.xml/UnusedReturnValue"/>
  <rule ref="category/java/errorprone.xml/UnconditionalIfStatement"/>
  <rule ref="category/java/performance.xml/StringToString"/>
  <rule ref="category/java/performance.xml/StringInstantiation"/>
  <rule ref="category/java/performance.xml/UselessStringValueOf"/>
  <rule ref="category/java/performance.xml/AddEmptyString"/>

  <!-- errors that disappear -->
  <rule ref="category/java/errorprone.xml/EmptyCatchBlock"/>
  <rule ref="category/java/errorprone.xml/AvoidCatchingGenericException"/>
  <rule ref="category/java/design.xml/AvoidThrowingRawExceptionTypes"/>
  <rule ref="category/java/design.xml/AvoidRethrowingException"/>
  <rule ref="category/java/bestpractices.xml/PreserveStackTrace"/>
  <rule ref="category/java/bestpractices.xml/AvoidPrintStackTrace"/>
  <!-- A command-line program prints by design: delete this line there, with a comment saying so. -->
  <rule ref="category/java/bestpractices.xml/SystemPrintln"/>
  <rule ref="category/java/errorprone.xml/DoNotTerminateVM"/>

  <!-- resources and concurrency (System.gc() in production is SpotBugs' DM_GC; tests may request a collection) -->
  <rule ref="category/java/errorprone.xml/CloseResource"/>
  <rule ref="category/java/bestpractices.xml/UseTryWithResources"/>
  <rule ref="category/java/performance.xml/UseStringBufferForStringAppends"/>
  <rule ref="category/java/performance.xml/InefficientStringBuffering"/>
  <rule ref="category/java/multithreading.xml/DoubleCheckedLocking"/>
  <rule ref="category/java/multithreading.xml/NonThreadSafeSingleton"/>
  <rule ref="category/java/multithreading.xml/UnsynchronizedStaticFormatter"/>
  <rule ref="category/java/errorprone.xml/AssignmentToNonFinalStatic"/>

  <!-- tests that do not test -->
  <rule ref="category/java/bestpractices.xml/UnitTestShouldIncludeAssert"/>
  <rule ref="category/java/bestpractices.xml/UnitTestContainsTooManyAsserts">
    <properties>
      <property name="maximumAsserts" value="4"/>
    </properties>
  </rule>
  <rule ref="category/java/errorprone.xml/DetachedTestCase"/>
  <rule ref="category/java/errorprone.xml/TestClassWithoutTestCases"/>

  <!-- leaks -->
  <rule name="UnboundedStaticCollection"
        language="java"
        message="A static mutable collection lives as long as its class loader: bound it, give it an owner with a lifecycle, or build it once with Map.copyOf / List.copyOf"
        class="net.sourceforge.pmd.lang.rule.xpath.XPathRule">
    <description>A static field initialised with a new mutable collection or map: whatever code adds to it stays reachable until the class unloads.</description>
    <priority>1</priority>
    <properties>
      <property name="xpath">
        <value><![CDATA[
//FieldDeclaration[pmd-java:modifiers() = 'static']
  /VariableDeclarator/ConstructorCall[pmd-java:typeIs('java.util.Collection') or pmd-java:typeIs('java.util.Map')]
]]></value>
      </property>
    </properties>
  </rule>
  <rule name="ThreadLocalWithoutRemove"
        language="java"
        message="A ThreadLocal nothing ever removes keeps its value alive as long as the thread, which in a pool is forever: remove() it in a finally, or use a ScopedValue"
        class="net.sourceforge.pmd.lang.rule.xpath.XPathRule">
    <description>A ThreadLocal field whose class never calls remove() on it.</description>
    <priority>1</priority>
    <properties>
      <property name="xpath">
        <value><![CDATA[
//FieldDeclaration/VariableDeclarator/VariableId[pmd-java:typeIs('java.lang.ThreadLocal')]
  [let $name := @Name return
     not(ancestor::ClassBody[1]//MethodCall[@MethodName = 'remove'][*[1][@Name = $name]])]
]]></value>
      </property>
    </properties>
  </rule>
</ruleset>
```

### 2.7 `config/spotbugs/exclude.xml`

SpotBugs reports at every confidence level, so this file is the only place a pattern leaves the gate, and each entry says why.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<FindBugsFilter xmlns="https://github.com/spotbugs/filter/3.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="https://github.com/spotbugs/filter/3.0.0 https://raw.githubusercontent.com/spotbugs/spotbugs/4.10.4/spotbugs/etc/findbugsfilter.xsd">
  <!-- find-sec-bugs' review markers: they flag every endpoint and every read of request data, safe or not, as a
       list for a security review. The injection detectors that follow that data (SQL_INJECTION, XSS_*,
       PATH_TRAVERSAL_*, ...) stay on. -->
  <Match>
    <Bug pattern="SPRING_ENDPOINT,JAXRS_ENDPOINT,JAXWS_ENDPOINT,STRUTS1_ENDPOINT,STRUTS2_ENDPOINT,TAPESTRY_ENDPOINT,WICKET_ENDPOINT,SERVLET_PARAMETER,SERVLET_HEADER,SERVLET_HEADER_REFERER,SERVLET_HEADER_USER_AGENT,SERVLET_QUERY_STRING,SERVLET_CONTENT_TYPE,SERVLET_SERVER_NAME,SERVLET_SESSION_ID,COOKIE_USAGE"/>
  </Match>
  <!-- EI_EXPOSE_REP2 (a constructor stores a caller's mutable object) is right for data and wrong for a collaborator
       that its owner hands in on purpose. Add one Match per collaborator type, with the reason, in this form:
         <Match><Bug pattern="EI_EXPOSE_REP2"/><Field type="<FULLY.QUALIFIED.Type>"/></Match>
       Never for a java.* type, an array or a date: copy those (List.copyOf, clone()). -->
</FindBugsFilter>
```

`EI_EXPOSE_REP2` is the one pattern that needs entries in a codebase that passes collaborators to constructors: SpotBugs treats any object with a mutating method (a cache's `put`, a repository's `save`) as data that should have been copied. The `type` attribute takes an exact class name; a regular expression there matches nothing.

### 2.8 `config/dead-code/` (the dead-code passes' inputs)

`proguard.pom.xml` is not a module of the build. It only pins ProGuard, so that `scripts/dead-code.sh` can resolve ProGuard's classpath through your Maven settings and mirrors (a Gradle build resolves it through Gradle instead, Phase 2.4).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- Not a module: scripts/dead-code.sh resolves ProGuard's classpath from this file. -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>local.gates</groupId>
  <artifactId>proguard-classpath</artifactId>
  <version>1</version>
  <packaging>pom</packaging>
  <dependencies>
    <dependency>
      <groupId>com.guardsquare</groupId>
      <artifactId>proguard-base</artifactId>
      <version>7.10.0</version>
    </dependency>
  </dependencies>
  <build>
    <pluginManagement>
      <plugins>
        <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-dependency-plugin</artifactId><version>3.11.0</version></plugin>
      </plugins>
    </pluginManagement>
  </build>
</project>
```

`keep.pro` names the production entry points that no call in the code reaches: what a framework instantiates, calls by annotation or reads by reflection. `scripts/dead-code.sh` already keeps main methods, enum `values()`/`valueOf()`, serialization members and every implementation listed in `src/main/resources/META-INF/services`. One rule per real caller, each with a comment naming it; never a rule that exists to make a finding go away.

```text
# Entry points of <REPO> that no call in the code reaches, for scripts/dead-code.sh (ProGuard syntax:
# https://www.guardsquare.com/manual/configuration/usage). Each rule names its caller.
#
# A library's callers are other people's code: its published API is the entry point, and the gate reports what the
# API does not reach. A public type in an `internal` (or `impl`) package is not API: leave it out of the rule, so a
# public method there that only a test calls is reported. Name your repo's internal packages the same way.
# -keep public class !<ROOT_PKG>.**.internal.**, <ROOT_PKG>.** { public protected *; }
# AspectJ weaves aspectOf() and the advice into the user's code, which this build never sees:
# -keep @org.aspectj.lang.annotation.Aspect class * { *; }
# The AWS SDK v2 instantiates every class named in software/amazon/awssdk/global/handlers/execution.interceptors:
# -keep class * implements software.amazon.awssdk.core.interceptor.ExecutionInterceptor { <init>(); }
# Spring creates components and calls their annotated members:
# -keep @org.springframework.stereotype.** class * { <init>(...); @org.springframework.** *; }
# -keep @org.springframework.context.annotation.Configuration class * { <init>(...); @org.springframework.context.annotation.Bean *; }
# JAX-RS resources:
# -keep @jakarta.ws.rs.Path class * { <init>(...); @jakarta.ws.rs.** *; }
# Types Jackson (de)serializes at the HTTP boundary: their accessors and constructors are called by reflection.
# -keep class <ROOT_PKG>.api.** { <init>(...); public <methods>; }
```


### 2.9 What the repo already does that changes the blocks above

Phase 0 told you which of these apply. Each was hit on a real codebase.

- **A module sets its own test JVM.** A module's `<argLine>` (Gradle: `jvmArgs(...)` replacing the list) replaces the root's, and its tests then run unbounded, unrecorded, and without the Mockito agent. Start it with the property: `<argLine>${gates.test.argLine} -Dwhat.the.module.needs=4</argLine>`. The same goes for a profile's `<argLine>` (a `jdk16` profile that adds `--add-opens`, for example). `JfrGate` fails on any module whose tests left no recording, so a missed one shows.
- **CI builds on several JDKs** (a library that supports 11 to 25). Error Prone needs 21 or newer, and `requireJavaVersion` pins the build JDK, so the gates run on the build JDK (25) only. Move the compiler's Error Prone arguments and `annotationProcessorPaths`, and the enforcer's `requireJavaVersion`, into a profile that switches itself on (`<activation><jdk>[25,)</jdk></activation>`). The other CI jobs build and test without them, and the JDK 25 job runs `scripts/validate.sh`. The `--release` and the test JVM stay outside the profile, so every job still compiles for the production release.
- **AspectJ.** The `aspectj-maven-plugin` runs `ajc` after javac and recompiles the sources, so the classes that ship are `ajc`'s, not the ones javac, Error Prone and NullAway checked. Every module then needs `org.aspectj:aspectjrt` on its classpath, including a module without aspects (list it in that module's `ignoredUnusedDeclaredDependencies`, with that reason). javac's switch-map classes (`Foo$1`) that `ajc` does not use stay behind in the jar; `dead-code.sh` reports them as whole unreachable classes. Report them; do not change the weaving (rule 5).
- **Generated sources** (protobuf, Avro, OpenAPI): PMD and Error Prone already skip `target/generated-*` and `build/generated`, and `dead-code.sh` keeps every class compiled from them.

### 2.10 State shared between threads

No gate can tell which objects several threads reach; the code has to say it, and then Error Prone checks it. On a real codebase this was the one serious bug no gate caught: an idempotency store's LRU cache, a `LinkedHashMap` in access order (so even `get` changes it) with no lock, reached by the documented `parallelStream()` batch processing.

For every object Phase 0 found on a path that runs on several threads (a parallel stream, an executor, a framework's worker pool), and every singleton, pick one:

- **Immutable**: final fields of immutable types; annotate the class `@com.google.errorprone.annotations.Immutable` and Error Prone's `Immutable` check (on by default) fails a mutable field.
- **A concurrent type**: `ConcurrentHashMap`, `AtomicLong`, a cache library built for it.
- **A lock**: annotate each field `@com.google.errorprone.annotations.concurrent.GuardedBy("this")` (or the lock's name) and Error Prone's `GuardedBy` check (on by default) fails every access that does not hold it.

Add `error_prone_annotations` (managed in 2.2) to the modules that use them. A shared object with a plain mutable collection and none of the three is a finding in the report, top tier.

---

## Phase 3: memory, garbage collection and the JDK

Static analysis finds the leak patterns it can see (Phase 2.6, SpotBugs, Error Prone). This phase measures the rest at run time, with the same rule as everything else: each gate is a count that must be zero, or a budget that was measured and is never raised.

### 3.1 The test JVM: bounded, recorded, and like production

The surefire `argLine` of Phase 2.2 (Gradle: the `test` task of Phase 2.4) makes each module's test JVM:

- **Bounded.** `-Xmx` and `-XX:MaxMetaspaceSize` cap the heap and the class metadata. One reused JVM per module (`forkCount=1`, `reuseForks=true`) runs the whole suite, so an object a static field keeps from one test to the next accumulates, and a bounded heap turns that into a failure instead of a production incident.
- **Stopped, with evidence, on `OutOfMemoryError`.** `-XX:+HeapDumpOnOutOfMemoryError` writes `java_pid<pid>.hprof` into the module's build directory, and `-XX:+ExitOnOutOfMemoryError` stops the JVM, so no later test runs in a broken heap. Surefire then reports that the forked VM terminated.
- **Recorded.** `-XX:StartFlightRecording` writes a JFR recording per test JVM (`test-jvm-<pid>.jfr`) and `-Xlog:gc` a one-line-per-collection GC log beside it. `scripts/JfrGate.java` (3.6) gates on the recordings and prints what they measured. `-Xlog:jfr+startup=off` keeps JFR's startup lines off standard output, which Surefire uses to talk to its forked JVM ("Corrupted channel by directly writing to native stream").
- **Like production.** `gates.test.gc` is the collector production runs, written explicitly. The JVM picks a collector by ergonomics when none is given: in a container with fewer than 2 CPUs or less than 1792 MB of memory it picks Serial, not G1, and it gives the heap a quarter of the memory. Measured for this brief with `eclipse-temurin:25-jre`: `--memory=1g --cpus=1` runs Serial with a 256 MB heap, `--memory=2g --cpus=2` runs G1 with 512 MB. AWS Lambda runs Serial whatever the size (3.8). Measure production's (3.8) instead of assuming. Do not copy `-XX:+DisableExplicitGC` into the test JVM: `Collectability` (3.3) requests collections.

Size the bounds from a measurement, never from a guess:

1. Run the suite once with generous bounds (**[maven]** `-Dgates.test.heap=2g -Dgates.test.metaspace=512m`, **[gradle]** `-Pgates.test.heap=2g -Pgates.test.metaspace=512m`), then run `java scripts/JfrGate.java .`. It prints the peak heap and metaspace in use after a collection: the suite's live set.
2. Set `gates.test.heap` to four times the peak live heap, rounded up to a power of two and at least `128m`, and `gates.test.metaspace` to twice the peak metaspace, at least `128m`. Neither may exceed what production gives the JVM (3.8): a suite that needs more heap than production has is a finding.
3. Record both measurements and both settings in the report. Never raise them afterwards. When a change makes the suite outgrow its heap, read the heap dump (3.7) first; the usual cause is a fixture or a static cache that keeps what it should drop. A test context cache that legitimately grows (Spring keeps up to 32 application contexts alive) is fixed by fewer distinct contexts or `spring.test.context.cache.maxSize`, not by a bigger heap.

### 3.2 `NoThreadLeaks`: no test leaves a thread running

A thread that outlives its test keeps everything it references reachable, and in production the same code leaks a thread per request. This JUnit extension fails every test class that leaves a non-daemon thread running (an executor never shut down, a `Timer`, a started `Thread`). JUnit loads it for every test class, because `junit.jupiter.extensions.autodetection.enabled` is set in the build (Phase 2.2 / 2.4) and the extension is listed in `META-INF/services`.

`src/test/java/<ROOT_PKG as a path>/testing/NoThreadLeaks.java`:

```java
package <ROOT_PKG>.testing;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * Fails a test class that leaves a non-daemon thread running: an executor never shut down, a timer, a started
 * thread. Loaded for every test class through META-INF/services and JUnit's extension auto-detection.
 */
public final class NoThreadLeaks implements BeforeAllCallback, AfterAllCallback {
  private static final ExtensionContext.Namespace NAMESPACE = ExtensionContext.Namespace.create(NoThreadLeaks.class);
  private static final Duration GRACE = Duration.ofSeconds(2);
  /**
   * Name prefixes of threads a framework keeps on purpose across test classes, each with the reason. Empty until
   * a real one appears (for example the executor of a Spring context that the test context cache keeps alive).
   */
  private static final List<String> KEPT_ON_PURPOSE = List.of();

  /** The threads alive before the test class started (a class, not a record: the helpers compile for Java 11). */
  private static final class Before {
    private final Set<Thread> threads;

    Before(Set<Thread> threads) {
      this.threads = threads;
    }

    Set<Thread> threads() {
      return threads;
    }
  }

  @Override
  public void beforeAll(ExtensionContext context) {
    context.getStore(NAMESPACE).put(Before.class, new Before(Set.copyOf(Thread.getAllStackTraces().keySet())));
  }

  @Override
  public void afterAll(ExtensionContext context) throws InterruptedException {
    Before before = context.getStore(NAMESPACE).get(Before.class, Before.class);
    if (before == null) {
      return;
    }
    long deadline = System.nanoTime() + GRACE.toNanos();
    List<String> running = new ArrayList<>();
    for (Thread thread : startedSince(before)) {
      thread.join(Math.max(1, Duration.ofNanos(deadline - System.nanoTime()).toMillis()));
      if (thread.isAlive()) {
        running.add(thread.getName());
      }
    }
    if (!running.isEmpty()) {
      throw new AssertionError(context.getDisplayName() + " left threads running: " + running
          + ". Shut down every executor, timer and thread a test starts (an ExecutorService is AutoCloseable).");
    }
  }

  private static List<Thread> startedSince(Before before) {
    List<Thread> started = new ArrayList<>();
    for (Thread thread : Thread.getAllStackTraces().keySet()) {
      if (!thread.isDaemon() && !before.threads().contains(thread) && !keptOnPurpose(thread.getName())) {
        started.add(thread);
      }
    }
    return started;
  }

  private static boolean keptOnPurpose(String name) {
    return KEPT_ON_PURPOSE.stream().anyMatch(name::startsWith);
  }
}
```

`src/test/resources/META-INF/services/org.junit.jupiter.api.extension.Extension` (one line):

```text
<ROOT_PKG>.testing.NoThreadLeaks
```

### 3.3 `Collectability`: an object does not outlive its use

For every object that registers itself somewhere (a listener, a session, a subscription, an entry in a cache or registry keyed by something with a lifecycle), write one test that uses it the way production does, releases it, and asserts that nothing still holds it. The assertion fails when a static collection, a listener list, a `ThreadLocal` or a map keeps a reference, and its message says where to look.

`src/test/java/<ROOT_PKG as a path>/testing/Collectability.java`:

```java
package <ROOT_PKG>.testing;

import java.lang.ref.WeakReference;
import java.time.Duration;
import java.util.function.Supplier;

/**
 * Asserts that an object is garbage once its owner lets go of it:
 * {@code assertCollectable("a closed session", () -> { Session s = sessions.open(); s.close(); return s; });}
 * The supplier returns the object after its last use; only a weak reference to it is kept here.
 */
public final class Collectability {
  private static final Duration PATIENCE = Duration.ofSeconds(5);

  private Collectability() {}

  public static void assertCollectable(String what, Supplier<?> useAndRelease) {
    WeakReference<?> reference = new WeakReference<>(useAndRelease.get());
    long deadline = System.nanoTime() + PATIENCE.toNanos();
    while (reference.get() != null) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError(what + " is still reachable after " + PATIENCE.toSeconds()
            + " s of collections: something keeps a reference to it (a static collection, a listener, a ThreadLocal,"
            + " a cache). Take a heap dump (jcmd <pid> GC.heap_dump) and follow its path to a GC root.");
      }
      // A request, not an order: the loop repeats it until the collector clears the reference or time runs out.
      System.gc();
    }
  }
}
```

### 3.4 `AllocationBudget`: a hot path allocates what it allocated when it was measured

Allocation is the one memory cost a unit test can measure exactly: HotSpot counts the bytes each thread allocates. A budget test pins a hot path's allocation, so boxing, a stream, a varargs array, an iterator, a `String.format` or a defensive copy added later fails it. Time is not measured: it is noise on a shared CI machine, and JMH is the tool for it.

`src/test/java/<ROOT_PKG as a path>/testing/AllocationBudget.java`:

```java
package <ROOT_PKG>.testing;

import com.sun.management.ThreadMXBean;
import java.lang.management.ManagementFactory;

/**
 * The bytes one run of {@code work} allocates on the current thread, as HotSpot counts them. The first run is not
 * measured: class initialisation and invokedynamic linkage allocate once.
 * {@code assertThat(AllocationBudget.bytesAllocatedBy(() -> pricing.total(basket))).isLessThanOrEqualTo(BUDGET);}
 */
public final class AllocationBudget {
  private static final ThreadMXBean THREADS = (ThreadMXBean) ManagementFactory.getThreadMXBean();

  private AllocationBudget() {}

  public static long bytesAllocatedBy(Runnable work) {
    work.run();
    // getThreadAllocatedBytes(id), not getCurrentThreadAllocatedBytes(): the helpers compile for Java 11 (the latter is 14+).
    // With <JAVA_RELEASE> 19 or newer, javac's deprecation lint flags getId(): use getCurrentThreadAllocatedBytes() there.
    long before = THREADS.getThreadAllocatedBytes(Thread.currentThread().getId());
    work.run();
    return THREADS.getThreadAllocatedBytes(Thread.currentThread().getId()) - before;
  }
}
```

How to set a budget: measure first. Assert `isLessThanOrEqualTo(0)`, run the test, read the actual value from the failure (`Expecting actual: 88L to be less than or equal to: 0L`), and set the budget constant to that value, with a comment saying what it covers ("the entry set and its iterator; no boxing"). The value is exact and repeatable for the same inputs: in this brief's proof it was the same on every run, under Maven and Gradle. It can only fall as the JIT removes allocations, so the test does not flake upwards. Measure the code the way production calls it, with real collaborators: a Mockito mock records every call it receives, and allocates doing it (the proof's cached quote measured 3,120 bytes through a mock and 464 without). Never raise a budget to make a change pass: find the allocation first (`jfr view allocation-by-site` on the test recording, 3.7). `work` runs twice and only the second run is measured, so it must do the same thing both times: a `put` of a new key measures its entry the first time and nothing the second. Measure a lookup, a serialization or a request, and build what it mutates inside the lambda. Before trusting a budget of 0, prove the meter sees something: `bytesAllocatedBy(() -> sink = new ArrayList<>(List.of("x")))` measured 96 bytes on JDK 25.

### 3.5 Where the helpers live

In a single-module build, the three classes and the services file live in that module's `src/test`. In a multi-module build, put them in **one** module (copies in several modules would be CPD clones) and share them:

- **[maven]** In that module's pom, publish the helpers as a test jar, and only them. A test jar holds every test class of its module by default: every module that depends on it then gets that module's tests too, and PIT runs them there (they fail, and the mutation report cannot start). If the module already publishes a test jar (Phase 0), add the `<configuration>` to its existing execution instead of a second one, and list what the other modules already use from it (stubs, fixtures):

  ```xml
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-jar-plugin</artifactId>
        <executions>
          <execution>
            <id>gates-test-support</id>
            <goals><goal>test-jar</goal></goals>
            <configuration>
              <includes>
                <include><ROOT_PKG as a path>/testing/**</include>
                <include>META-INF/services/org.junit.jupiter.api.extension.Extension</include>
                <!-- and whatever else other modules' tests import from this module, e.g. <ROOT_PKG as a path>/stubs/** -->
              </includes>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
  ```

  Inside the reactor, before `package`, Maven hands other modules this module's whole `target/test-classes` instead of the jar, so the includes only apply from `package` on: that is why `scripts/mutation-report.sh` runs `package` before PIT.

  and in every other module with tests:

  ```xml
  <dependency>
    <groupId>${project.groupId}</groupId>
    <artifactId><SUPPORT_MODULE></artifactId>
    <version>${project.version}</version>
    <type>test-jar</type>
    <scope>test</scope>
  </dependency>
  ```

  The services file travels inside the test jar, so `NoThreadLeaks` runs in every module that depends on it. A module that uses none of the three classes directly still needs the dependency for the extension; say so in that module's pom, keeping the root's entries:

  ```xml
  <plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-dependency-plugin</artifactId>
    <configuration>
      <ignoredUnusedDeclaredDependencies combine.children="append">
        <!-- JUnit loads NoThreadLeaks from this test jar through META-INF/services. -->
        <ignoredUnusedDeclaredDependency>${project.groupId}:<SUPPORT_MODULE></ignoredUnusedDeclaredDependency>
      </ignoredUnusedDeclaredDependencies>
    </configuration>
  </plugin>
  ```
- **[gradle]** Put them in `src/testFixtures` of that project instead (`src/testFixtures/java/<ROOT_PKG as a path>/testing/`, and the services file in `src/testFixtures/resources/META-INF/services/`), add the `java-test-fixtures` plugin next to `id("quality-gates")` with `testFixturesApi(platform("org.junit:junit-bom:6.1.3"))` and `testFixturesApi("org.junit.jupiter:junit-jupiter-api")` (api, because `NoThreadLeaks` exposes JUnit's types to the projects that use it), and in every other project with tests `testImplementation(testFixtures(project(":<SUPPORT_PROJECT>")))`. A single-project build does the same with its own `src/testFixtures`, or keeps them in `src/test`.

### 3.6 `scripts/JfrGate.java`: the test JVMs' garbage collection, measured and gated

A single-file Java program the build JDK runs from source. It reads every recording the test JVMs wrote and fails on counts that must be zero:

- **A module whose tests ran without a recording**: it has JUnit reports but no `test-jvm-<pid>.jfr`, so its own `<argLine>` or `jvmArgs` replaced the gated one (Phase 2.9), and none of the other gates saw it.
- **A full collection nobody asked for** (`G1Full`, `SerialOld`, `ParallelOld` not caused by `System.gc()` or a diagnostic command): the heap ran out of room.
- **A full collection forced by metaspace** (cause `Metadata GC Threshold`): class loading outgrew `-XX:MetaspaceSize`, which the test JVM sets to `gates.test.metaspace`. Without that flag every JVM starts with a threshold of about 21 MB and runs a full collection each time metaspace crosses it, which is class loading, not a heap problem: on a real 20-module suite that was 37 of 37 full collections.
- **A G1 evacuation failure**: no free region to copy live objects into.
- **A ZGC allocation stall**: a thread waited for memory.
- **A pause longer than `--max-pause-ms`**: 200 by default, a sanity bound for small test heaps, not a latency target.
- **A virtual thread pinned to its carrier** for longer than JFR's 20 ms threshold.

It also prints what it measured, so the report can quote it and step 1 of 3.1 can size the bounds. JFR samples the thread count once a second, so a suite that runs for less prints `peak threads n/a`.

```java
/*
 * The test JVMs' memory and garbage collection, measured from the JFR recordings the test argLine asks each test
 * JVM to write (test-jvm-<pid>.jfr in each module's build directory). Gates, each of which must be 0: modules whose
 * tests ran without a recording (a module's own argLine replaced the gated one), full collections nobody asked for,
 * full collections forced by metaspace, G1 evacuation failures, ZGC allocation stalls, pauses over --max-pause-ms,
 * pinned virtual threads, unreadable recordings. Prints the collector, max heap, collections and pauses, peak heap and
 * metaspace after a collection, peak thread count, and the sampled allocation by class.
 * Usage: java scripts/JfrGate.java [--max-pause-ms 200] <repo dir>
 */
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import jdk.jfr.consumer.RecordedEvent;
import jdk.jfr.consumer.RecordingFile;

final class JfrGate {
  private static final Set<String> FULL_COLLECTIONS = Set.of("G1Full", "SerialOld", "ParallelOld");
  private static final Set<String> REQUESTED = Set.of(
      "System.gc()", "Diagnostic Command", "Heap Dump Initiated GC", "Heap Inspection Initiated GC");
  private static final long MB = 1024 * 1024;
  /** Where Maven and Gradle write a module's test reports, relative to the module, and its build directory. */
  private static final Map<String, String> REPORTS = Map.of(
      "target/surefire-reports", "target", "build/test-results/test", "build");

  private final Set<String> collectors = new TreeSet<>();
  private final Map<String, Long> allocationByClass = new HashMap<>();
  /** Each gate, and where it fired (one entry per collection or event, never twice for the same one). */
  private final Map<String, Set<String>> gates = new LinkedHashMap<>();
  private final Duration maxPause;
  private long maxHeap;
  private long collections;
  private long pausesNanos;
  private long longestPauseNanos;
  private long peakHeapAfterGc;
  private long peakMetaspaceAfterGc;
  private long peakThreads;
  private long sampledAllocation;

  private JfrGate(Duration maxPause) {
    this.maxPause = maxPause;
    for (String gate : List.of("test JVMs without a recording", "full collections nobody asked for",
        "full collections forced by metaspace", "G1 evacuation failures", "ZGC allocation stalls",
        "pauses over " + maxPause.toMillis() + " ms", "pinned virtual threads", "unreadable recordings")) {
      gates.put(gate, new LinkedHashSet<>());
    }
  }

  public static void main(String[] args) throws IOException {
    long maxPauseMs = 200;
    Path root = Path.of(".");
    for (int i = 0; i < args.length; i++) {
      if (args[i].equals("--max-pause-ms") && i + 1 < args.length) {
        maxPauseMs = Long.parseLong(args[++i]);
      } else {
        root = Path.of(args[i]);
      }
    }
    List<Path> recordings;
    try (Stream<Path> files = Files.walk(root, 6)) {
      recordings = files
          .filter(p -> p.getFileName().toString().matches("test-jvm-\\d+\\.jfr"))
          .filter(p -> !p.toString().contains("node_modules"))
          .sorted()
          .toList();
    }
    if (recordings.isEmpty()) {
      System.out.println("jfr: no test-jvm-<pid>.jfr under " + root + ": is the test argLine of Phase 2 in place, and did the tests run?");
      System.exit(1);
    }
    JfrGate gate = new JfrGate(Duration.ofMillis(maxPauseMs));
    gate.everyTestJvmRecorded(root, recordings);
    for (Path recording : recordings) {
      gate.read(recording);
    }
    System.exit(gate.print(recordings.size()) ? 0 : 1);
  }

  /** A module whose tests ran (it has JUnit XML reports) but left no recording ran outside the gated test JVM. */
  private void everyTestJvmRecorded(Path root, List<Path> recordings) throws IOException {
    Set<Path> recorded = new TreeSet<>();
    for (Path recording : recordings) {
      recorded.add(recording.toAbsolutePath().normalize().getParent());
    }
    for (Map.Entry<String, String> layout : REPORTS.entrySet()) {
      Path suffix = Path.of(layout.getKey());
      List<Path> reportDirs;
      try (Stream<Path> dirs = Files.walk(root, 8)) {
        reportDirs = dirs.filter(Files::isDirectory).filter(d -> d.endsWith(suffix))
            .filter(d -> !d.toString().contains("node_modules")).toList();
      }
      for (Path reports : reportDirs) {
        boolean ran;
        try (Stream<Path> files = Files.list(reports)) {
          ran = files.anyMatch(f -> f.getFileName().toString().matches("TEST-.*\\.xml"));
        }
        Path module = reports;
        for (int i = 0; i < suffix.getNameCount(); i++) {
          module = module.getParent();
        }
        Path buildDir = module.resolve(layout.getValue()).toAbsolutePath().normalize();
        if (ran && !recorded.contains(buildDir)) {
          fired("test JVMs without a recording", root.relativize(module) + ": its test JVM did not get the gated"
              + " argLine (a module-level argLine or jvmArgs that does not start with ${gates.test.argLine})");
        }
      }
    }
  }

  private void fired(String gate, String where) {
    gates.get(gate).add(where);
  }

  private void read(Path recording) {
    String file = recording.getFileName().toString();
    try (RecordingFile events = new RecordingFile(recording)) {
      while (events.hasMoreEvents()) {
        event(events.readEvent(), file);
      }
    } catch (IOException e) {
      fired("unreadable recordings", file + " (" + e.getMessage() + "): its JVM died before writing it, after an OutOfMemoryError or a crash");
    }
  }

  private void event(RecordedEvent event, String file) {
    switch (event.getEventType().getName()) {
      case "jdk.GarbageCollection" -> collection(event, file);
      case "jdk.GCHeapSummary" -> {
        if ("After GC".equals(event.getString("when"))) {
          peakHeapAfterGc = Math.max(peakHeapAfterGc, event.getLong("heapUsed"));
        }
      }
      case "jdk.MetaspaceSummary" -> {
        if ("After GC".equals(event.getString("when"))) {
          peakMetaspaceAfterGc = Math.max(peakMetaspaceAfterGc, event.getLong("metaspace.used"));
        }
      }
      case "jdk.GCConfiguration" -> collectors.add(event.getString("youngCollector") + "/" + event.getString("oldCollector"));
      case "jdk.GCHeapConfiguration" -> maxHeap = Math.max(maxHeap, event.getLong("maxSize"));
      case "jdk.JavaThreadStatistics" -> peakThreads = Math.max(peakThreads, event.getLong("peakCount"));
      case "jdk.ObjectAllocationSample" -> {
        long weight = event.getLong("weight");
        sampledAllocation += weight;
        allocationByClass.merge(readable(event.getClass("objectClass").getName()), weight, Long::sum);
      }
      case "jdk.EvacuationFailed" -> fired("G1 evacuation failures", "GC " + event.getInt("gcId") + " in " + file);
      case "jdk.ZAllocationStall" -> fired("ZGC allocation stalls", event.getDuration().toMillis() + " ms at " + event.getStartTime() + " in " + file);
      case "jdk.VirtualThreadPinned" -> fired("pinned virtual threads", event.getDuration().toMillis() + " ms in "
          + (event.getStackTrace() == null || event.getStackTrace().getFrames().isEmpty()
              ? "an unknown frame" : event.getStackTrace().getFrames().getFirst().getMethod().getName()) + ", " + file);
      default -> { }
    }
  }

  private void collection(RecordedEvent event, String file) {
    String name = event.getString("name");
    String cause = event.getString("cause");
    Duration longest = event.getDuration("longestPause");
    String where = "GC " + event.getInt("gcId") + " in " + file;
    collections++;
    pausesNanos += event.getDuration("sumOfPauses").toNanos();
    longestPauseNanos = Math.max(longestPauseNanos, longest.toNanos());
    if (FULL_COLLECTIONS.contains(name) && "Metadata GC Threshold".equals(cause)) {
      fired("full collections forced by metaspace", name + ", " + where + ": class metadata outgrew the initial"
          + " -XX:MetaspaceSize; the test JVM sets it to gates.test.metaspace, so class loading grew past the bound");
    } else if (FULL_COLLECTIONS.contains(name) && !REQUESTED.contains(cause)) {
      fired("full collections nobody asked for", name + " (" + cause + "), " + where);
    }
    if (longest.compareTo(maxPause) > 0) {
      fired("pauses over " + maxPause.toMillis() + " ms", longest.toMillis() + " ms, " + where);
    }
  }

  /** JFR names arrays the way the JVM does ("[B", "[Ljava.lang.String;"); print them the way Java code does. */
  private static String readable(String name) {
    int dimensions = 0;
    while (dimensions < name.length() && name.charAt(dimensions) == '[') {
      dimensions++;
    }
    if (dimensions == 0) {
      return name;
    }
    String element = switch (name.charAt(dimensions)) {
      case 'B' -> "byte";
      case 'C' -> "char";
      case 'D' -> "double";
      case 'F' -> "float";
      case 'I' -> "int";
      case 'J' -> "long";
      case 'S' -> "short";
      case 'Z' -> "boolean";
      default -> name.substring(dimensions + 1, name.length() - 1);
    };
    return element + "[]".repeat(dimensions);
  }

  /** Prints the measurements and every gate's count; true when every gate is at 0. */
  private boolean print(int recordings) {
    System.out.printf("jfr: %d recordings, collectors %s, max heap %d MB%n", recordings, collectors, maxHeap / MB);
    System.out.printf("jfr: %d collections, pauses %.1f ms in total, longest %.1f ms%n",
        collections, pausesNanos / 1e6, longestPauseNanos / 1e6);
    System.out.printf("jfr: peak after a collection: heap %.1f MB, metaspace %.1f MB; peak threads %s%n",
        peakHeapAfterGc / (double) MB, peakMetaspaceAfterGc / (double) MB, peakThreads == 0 ? "n/a" : Long.toString(peakThreads));
    StringBuilder top = new StringBuilder();
    allocationByClass.entrySet().stream()
        .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
        .limit(5)
        .forEach(e -> top.append(top.isEmpty() ? "" : ", ").append(e.getKey()).append(' ').append(e.getValue() / MB).append(" MB"));
    System.out.printf("jfr: sampled allocation %d MB; most by class: %s%n", sampledAllocation / MB, top);
    boolean clean = true;
    for (Map.Entry<String, Set<String>> gate : gates.entrySet()) {
      Set<String> hits = gate.getValue();
      System.out.printf("jfr gate: %s: %d%s%n", gate.getKey(), hits.size(), hits.isEmpty() ? "" : " (first: " + hits.iterator().next() + ")");
      clean &= hits.isEmpty();
    }
    return clean;
  }
}
```

### 3.7 When a memory gate fails: find the retaining path, then fix the owner

- **OutOfMemoryError in the tests**: open the module's `java_pid<pid>.hprof` in Eclipse MAT (Leak Suspects, then "Path to GC Roots", excluding weak references), or run MAT's batch mode: `ParseHeapDump.sh <file>.hprof org.eclipse.mat.api:suspects`. The largest retained set and its path name the owner that keeps it.
- **A `Collectability` failure**: take a heap dump while the object is still reachable (`jcmd <pid> GC.heap_dump /tmp/leak.hprof`, with the pid from `jcmd -l`) and follow the object's path to a GC root. The first static field, `ThreadLocal`, listener list or cache on that path is the owner to fix.
- **A full collection or a heap that grows in the recording**: `jfr view memory-leaks-by-class <recording>` and `jfr view memory-leaks-by-site <recording>` list the old objects JFR sampled with where they were allocated; `jfr view gc <recording>` shows the heap after each collection.
- **An allocation budget exceeded**: `jfr view allocation-by-site <recording>` and `jfr view allocation-by-class <recording>`; the new allocation is usually boxing, a stream or iterator, a varargs array, a lambda capturing state, a `String.format`, a regex compiled per call, or a defensive copy.
- **A thread leak**: `jcmd <pid> Thread.print`, or the thread names in the failure; the fix is an owner that shuts the executor down (an `ExecutorService` is `AutoCloseable` since JDK 19).

### 3.8 The production JVM: measure it, report it, change nothing

What the JVM does in production depends on flags and on the container it runs in. Measure it once, put the numbers in the report, and propose (do not make) any change (rule 5):

```bash
# What the JVM picks inside production's container: its collector, max heap, CPUs.
docker run --rm --memory=<LIMIT> --cpus=<CPUS> <PRODUCTION_IMAGE> java <PRODUCTION_JVM_FLAGS> -XX:+PrintFlagsFinal -version \
  | grep -E ' (UseSerialGC|UseG1GC|UseZGC|UseParallelGC|UseShenandoahGC|MaxHeapSize|MaxRAMPercentage|ActiveProcessorCount|MaxDirectMemorySize|MaxMetaspaceSize) '
docker run --rm --memory=<LIMIT> --cpus=<CPUS> <PRODUCTION_IMAGE> java -XshowSettings:system -version   # the limits the JVM detected

# On a running JVM (pid from `jcmd -l`); NMT needs -XX:NativeMemoryTracking=summary at start.
jcmd <pid> VM.flags
jcmd <pid> GC.heap_info
jcmd <pid> VM.native_memory summary        # heap + metaspace + threads + code cache + GC + direct buffers: what the container sees
jcmd <pid> GC.class_histogram | head -25   # note: forces a full collection
jcmd <pid> JFR.start duration=300s filename=/tmp/prod.jfr settings=profile
jfr view gc-pauses /tmp/prod.jfr; jfr view gc /tmp/prod.jfr; jfr view allocation-by-class /tmp/prod.jfr; jfr view memory-leaks-by-class /tmp/prod.jfr
```

**On a serverless platform the production JVM is the platform's**, and its image says what it runs. AWS Lambda's runtime images start the JVM through `/var/runtime/bootstrap`, which computes the heap from `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`; run it with `-XX:+PrintFlagsFinal` and read the flags before it fails to reach the runtime API:

```bash
for v in 11 21 25; do for m in 512:0.29 1769:1 3008:2; do mem=${m%%:*}; cpu=${m##*:}
  echo "== java:$v ${mem} MB ${cpu} vCPU"
  docker run --rm --memory=${mem}m --cpus=$cpu -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=$mem -e _HANDLER=x.Y::h \
    -e AWS_LAMBDA_RUNTIME_API=127.0.0.1:1 -e JAVA_TOOL_OPTIONS=-XX:+PrintFlagsFinal --entrypoint sh \
    public.ecr.aws/lambda/java:$v -c '(/var/runtime/bootstrap & p=$!; sleep 8; kill $p) 2>&1' \
    | grep -E ' (UseSerialGC|UseG1GC|MaxHeapSize|MaxMetaspaceSize|TieredStopAtLevel|ReservedCodeCacheSize) ' | awk '{print $2"="$4}' | paste -sd' ' -
done; done
```

Measured on 2026-09-25: Serial on every runtime and size, a heap of about 85 % of the function's memory (436 MB of 512), Java 11 capping metaspace at 51 MB for 512 MB, Java 21 and 25 leaving it unbounded, and Java 21 stopping the JIT at tier 1. That leaves about 76 MB of a 512 MB function for metaspace, code cache, threads and direct buffers: report it with the library's measured metaspace, and propose nothing to the platform.

Report: the collector and max heap production actually gets, the container limit, and the native memory beyond the heap (NMT's `Total: committed` minus `Java Heap: committed`). A JVM whose heap plus metaspace, thread stacks, code cache, GC structures and direct buffers exceeds the container limit is killed by the kernel's OOM killer, with no `OutOfMemoryError` and no heap dump. For scale, from this brief's proof: a JVM with a 256 MB G1 heap committed 347 MB in total, 58 MB of it G1's own structures. The common finding is the default heap: a quarter of the container's memory when neither `-Xmx` nor `-XX:MaxRAMPercentage` is set (`--memory=1g --cpus=1` printed `UseSerialGC=true` and `MaxHeapSize=268435456`).

### 3.9 `scripts/jdk-report.sh`: the JDK the code needs, and what a JDK upgrade will break

The program's own code cannot use a JDK-internal API: with `--release`, a non-exported JDK package does not compile, and `sun.misc.Unsafe` and the other `jdk.unsupported` classes raise a warning that `-Werror` turns into a failure. The risk is in the dependencies, which were compiled elsewhere. This report lists it, and the modules a `jlink` runtime image needs:

```bash
#!/usr/bin/env bash
# The JDK this code builds on, targets and depends on: the build JDK, the release the classes target, the JDK modules
# they need (a jlink image's --add-modules), JDK-internal APIs the dependencies use, and the dependencies' uses of
# APIs the JDK deprecated for removal. A report: run it before a JDK upgrade and act on what it lists.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/bytecode-inputs.sh
source scripts/bytecode-inputs.sh

bytecode_inputs main
cp_args=()
if [[ -n "$LIBRARIES" ]]; then cp_args=(--class-path "$(paste -sd: - <<<"$LIBRARIES")"); fi
echo "build JDK: $(java -version 2>&1 | head -1)"
echo "release:   $RELEASE"
# shellcheck disable=SC2086  # PROGRAM is one directory per line, without spaces
echo "modules:   $(jdeps --multi-release "$RELEASE" --ignore-missing-deps --print-module-deps --recursive ${cp_args[@]+"${cp_args[@]}"} $PROGRAM)"
jars="$(grep '\.jar$' <<<"$LIBRARIES" || true)"
if [[ -z "$jars" ]]; then echo "no dependency jars"; exit 0; fi
echo "JDK-internal APIs used by dependencies (none if empty):"
# Each jar on its own, with the others as its class path (a modular jar otherwise stops jdeps with "Module ... not
# found"). jdeps then also reports classes of the class path, so keep only the lines about this jar's own classes.
all_jars="$(paste -sd: - <<<"$jars")"
while IFS= read -r jar; do
  own="$GATES_OUT/jdeps-own.txt"
  jar tf "$jar" | sed -nE 's#^(META-INF/versions/[0-9]+/)?(.*)\.class$#\2#p' | tr '/' '.' | sort -u > "$own"
  jdeps --multi-release "$RELEASE" --ignore-missing-deps --class-path "$all_jars" --jdk-internals "$jar" 2>/dev/null \
    | sed -nE 's#^ +([0-9]+/)?([^ ]+) +-> +([^ ]+) +JDK internal API.*#\2 \3#p' \
    | while read -r cls api; do
        if grep -qxF "$cls" "$own"; then echo "$(basename "$jar"): $cls -> $api"; fi
      done || true
done <<<"$jars" | sort -u
echo "APIs deprecated for removal, used by dependencies (none if empty):"
# shellcheck disable=SC2086
# "error: cannot find class/resolve" lines are optional dependencies that are not on the class path: counted, not listed.
jdeprscan --release "$RELEASE" --for-removal ${cp_args[@]+"${cp_args[@]}"} $jars > "$GATES_OUT/jdeprscan.txt" 2>&1 || true
grep -vE '^Jar file|^error: cannot (find class|resolve)' "$GATES_OUT/jdeprscan.txt" || true
echo "($(grep -cE '^error: cannot (find class|resolve)' "$GATES_OUT/jdeprscan.txt" || true) references jdeprscan could not resolve: optional dependencies not on the class path)"
```

Put its output in the report. A dependency on an internal API or a removed one is upgraded, replaced, or listed as the blocker of the next JDK upgrade.

---

## Phase 4: scripts

Create each shell script with `chmod +x`. They are bash, and they run on macOS's bash 3.2 as well as on Linux. The `.java` files are single-file programs the JDK runs from source (`java scripts/X.java`); they need the build JDK (25).

### 4.1 `scripts/bytecode-inputs.sh`: the compiled program and its classpath

```bash
#!/usr/bin/env bash
# Sourced by scripts/dead-code.sh and scripts/jdk-report.sh: the build's own compiled classes and the classpath they
# were compiled against, from Maven or Gradle. After `bytecode_inputs main` (or `test`):
#   PROGRAM    every module's class directories of that kind, absolute, one per line
#   LIBRARIES  every other entry of their classpaths, one per line (for `test`, the main class directories too)
#   RELEASE    the Java release the classes were compiled for (javac --release)
# proguard_classpath prints the classpath of the pinned ProGuard, resolved by the build tool (your mirrors apply).
# Paths must not contain spaces.
GATES_OUT=target/gates
if [[ ! -f pom.xml ]]; then GATES_OUT=build/gates; fi
mkdir -p "$GATES_OUT"
GATES_MEASURE=(-Dgates.werror=-Xlint:all -Dgates.nullaway=WARN -Dgates.errorprone.extra=-XepAllErrorsAsWarnings
  -Dcheckstyle.skip -Dcpd.skip -Dpmd.skip -Dspotbugs.skip -Dmdep.analyze.skip -Denforcer.skip)
JAVA_HOME_DIR="$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.home = //p')"

absolute_dirs() {  # the existing directories among $@, absolute, one per line
  local dir
  for dir in "$@"; do
    if [[ -d "$dir" ]]; then (cd "$dir" && pwd); fi
  done
}

bytecode_inputs() {
  local kind="$1" lists f
  if [[ -f pom.xml ]]; then
    local scope=compile output=classes
    if [[ "$kind" == test ]]; then scope=test; output=test-classes; fi
    # Compiled in measuring mode: this step needs the classes, not a verdict. The lifecycle gates are enforced by
    # `./mvnw verify` in scripts/validate.sh, and a baseline (Phase 6) must run before the code is clean.
    ./mvnw -q -B -ntp test-compile dependency:build-classpath -DincludeScope="$scope" "${GATES_MEASURE[@]}" \
      -Dmdep.outputFile="target/gates-$kind.classpath"
    lists="$(find . -path "*/target/gates-$kind.classpath" -not -path '*/node_modules/*' | sort)"
    PROGRAM="$(for f in $lists; do absolute_dirs "${f%/gates-$kind.classpath}/$output"; done)"
    MAIN_DIRS="$(for f in $lists; do absolute_dirs "${f%/gates-$kind.classpath}/classes"; done)"
  else
    ./gradlew -q gatesClasspath -Pgates.measure=true
    lists="$(find . -path "*/build/gates/$kind.classpath" -not -path '*/node_modules/*' | sort)"
    PROGRAM="$(for f in $lists; do absolute_dirs $(cat "${f%.classpath}.dirs"); done)"
    MAIN_DIRS="$(for f in $lists; do absolute_dirs $(cat "${f%/$kind.classpath}/main.dirs"); done)"
  fi
  LIBRARIES="$(
    {
      for f in $lists; do tr ':' '\n' < "$f"; echo; done
      if [[ "$kind" == test ]]; then printf '%s\n' "$MAIN_DIRS"; fi
    } | grep -v '^$' | sort -u | grep -vxF -f <(printf '%s\n' "$PROGRAM") \
      | while IFS= read -r entry; do if [[ -e "$entry" ]]; then echo "$entry"; fi; done || true
  )"
  local first
  # shellcheck disable=SC2086
  first="$(find $PROGRAM -name '*.class' -print -quit)"
  if [[ -z "$first" ]]; then echo "bytecode-inputs: no compiled $kind classes" >&2; return 2; fi
  RELEASE=$(( $(javap -v "$first" | sed -nE 's/.*major version: ([0-9]+).*/\1/p') - 44 ))
}

proguard_classpath() {
  local cp="$GATES_OUT/proguard.classpath"
  if [[ ! -s "$cp" ]]; then
    if [[ -f pom.xml ]]; then
      ./mvnw -q -B -ntp -f config/dead-code/proguard.pom.xml dependency:build-classpath -Dmdep.outputFile="$PWD/$cp"
    else
      ./gradlew -q gatesProguardClasspath "-Pgates.out=$PWD/$cp"
    fi
  fi
  cat "$cp"
}
```

### 4.2 `scripts/dead-code.sh`: dead Java code, two passes

ProGuard's shrinker is a reachability analysis: from the entry points it follows every call, field access, class reference, lambda and override, and `-printusage` lists what it never reached. No bytes are rewritten; nothing is written but the list. Tests sit in the same package as the code they test, so the test pass reads the production classes' package-private members too (`-dontskipnonpubliclibraryclassmembers`; without it ProGuard stops with "can't find referenced method"). Classes compiled from generated sources are kept whole. The scripts compile in measuring mode, so they run on a tree that has not reached zero yet (Phase 6); `validate.sh` has enforced the compile gates before it calls them.

```bash
#!/usr/bin/env bash
# Dead Java code, two passes, one gate. ProGuard walks the program from its real entry points and lists every class,
# method and field it cannot reach.
#   --production  every module's main classes. Entry points: main methods, enum values()/valueOf(), serialization
#                 members, META-INF/services implementations and config/dead-code/keep.pro. Tests are not entry
#                 points: code that only a test calls is dead.
#   --tests       every module's test classes. Entry points: what JUnit and Mockito run or inject. A helper or fixture
#                 that no test reaches is dead.
# javac inlines compile-time constants (static final primitives and Strings), so their uses are invisible in bytecode:
# this gate never reports them, and Error Prone's UnusedVariable reports the private ones.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/bytecode-inputs.sh
source scripts/bytecode-inputs.sh
FOUND_EXIT=3

case "${1:-}" in
  --production) kind=main ;;
  --tests) kind=test ;;
  *) echo "usage: $0 --production | --tests" >&2; exit 2 ;;
esac

bytecode_inputs "$kind"
proguard="$(proguard_classpath)"
cp_args=()
if [[ -n "$LIBRARIES" ]]; then cp_args=(--class-path "$(paste -sd: - <<<"$LIBRARIES")"); fi

# JDK builds since 24 (Temurin among them) ship without jmods (JEP 493), which ProGuard usually reads the JDK from:
# extract the class files of the JDK modules the program and its libraries use, and of the modules those require
# (a supertype can live there), once per JDK and module set.
# shellcheck disable=SC2086
modules="$(jdeps --multi-release "$RELEASE" --ignore-missing-deps --print-module-deps --recursive ${cp_args[@]+"${cp_args[@]}"} $PROGRAM \
  | tr ',' '\n' | sort -u | paste -sd, -)"
while :; do
  required="$(for m in ${modules//,/ }; do echo "$m"; java --describe-module "$m" | sed -nE 's/^requires ([a-z0-9.]+).*/\1/p'; done \
    | sort -u | paste -sd, -)"
  if [[ "$required" == "$modules" ]]; then break; fi
  modules="$required"
done
jdk="$PWD/$GATES_OUT/jdk-$(java -version 2>&1 | head -1 | tr -dc '[:alnum:].')/${modules//,/_}"
if [[ ! -d "$jdk" ]]; then
  jimage extract --dir "$jdk" --include "regex:/(${modules//,/|})/.*" "$JAVA_HOME_DIR/lib/modules"
fi

services() {  # a keep rule for every implementation named in a META-INF/services file of this kind
  local source_sets=main source_set dir
  if [[ "$kind" == test ]]; then source_sets="test testFixtures"; fi
  for source_set in $source_sets; do
    find . -path "*/src/$source_set/resources/META-INF/services" -type d -not -path '*/node_modules/*' | while IFS= read -r dir; do
      sed -E 's/#.*//; s/[[:space:]]//g' "$dir"/* | grep -v '^$' | sed 's/.*/-keep class & { <init>(); }/' || true
    done
  done
}

generated() {  # a keep rule for every class compiled from generated sources (protobuf, Avro, OpenAPI...): not ours to trim
  local dirs="generated-sources" f pkg name
  if [[ "$kind" == test ]]; then dirs="generated-test-sources"; fi
  find . \( -path "*/target/$dirs/*" -o -path "*/build/generated/*" \) -name '*.java' -not -path '*/node_modules/*' \
    | while IFS= read -r f; do
        if [[ "$kind" == main && "$f" == */build/generated/*/test/* ]]; then continue; fi
        pkg="$(awk '/^package /{ sub(/;.*/, "", $2); print $2; exit }' "$f")"
        name="$(basename "$f" .java)"
        printf -- '-keep class %s%s, %s%s$* { *; }\n' "${pkg:+$pkg.}" "$name" "${pkg:+$pkg.}" "$name"
      done
}

config="$GATES_OUT/dead-code-$kind.pro"
usage="$PWD/$GATES_OUT/unused-$kind.txt"
{
  printf '%s\n' -dontoptimize -dontobfuscate -dontpreverify -dontnote -dontskipnonpubliclibraryclassmembers \
    '-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Record,PermittedSubclasses,NestHost,NestMembers' \
    "-printusage '$usage'"
  while IFS= read -r dir; do printf '%s\n' "-injars '$dir'(**.class)"; done <<<"$PROGRAM"
  while IFS= read -r lib; do
    if [[ -n "$lib" ]]; then printf '%s\n' "-libraryjars '$lib'(!module-info.class,!META-INF/versions/**)"; fi
  done <<<"$LIBRARIES"
  for module in ${modules//,/ }; do printf '%s\n' "-libraryjars '$jdk/$module'(**.class,!module-info.class)"; done
  if [[ "$kind" == main ]]; then
    cat <<'EOF'
# Entry points every JVM program has, and the members the JVM calls by name.
-keepclasseswithmembers class * { public static void main(java.lang.String[]); }
-keepclasseswithmembers class * { static void main(java.lang.String[]); }
-keepclasseswithmembers class * { <init>(); void main(java.lang.String[]); }
-keepclasseswithmembers class * { static void main(); }
-keepclasseswithmembers class * { <init>(); void main(); }
-keepclassmembers enum * { public static **[] values(); public static ** valueOf(java.lang.String); }
-keepclassmembers class * implements java.io.Serializable {
  static final long serialVersionUID;
  private void writeObject(java.io.ObjectOutputStream);
  private void readObject(java.io.ObjectInputStream);
  java.lang.Object writeReplace();
  java.lang.Object readResolve();
}
EOF
    printf '%s\n' "-include '$PWD/config/dead-code/keep.pro'"
  else
    cat <<'EOF'
# What JUnit runs: every class with a test method, its constructors, and every member JUnit or Mockito finds by annotation.
-keepclasseswithmembers class * { <init>(...); @org.junit.jupiter.api.Test <methods>; }
-keepclasseswithmembers class * { <init>(...); @org.junit.jupiter.params.ParameterizedTest <methods>; }
-keepclasseswithmembers class * { <init>(...); @org.junit.jupiter.api.RepeatedTest <methods>; }
-keepclasseswithmembers class * { <init>(...); @org.junit.jupiter.api.TestFactory <methods>; }
-keepclasseswithmembers class * { <init>(...); @org.junit.jupiter.api.TestTemplate <methods>; }
-keepclasseswithmembers class * { <init>(...); @org.junit.Test <methods>; }
-keepclassmembers class * { @org.junit.** *; @org.mockito.** *; }
# @MethodSource names its provider in a string.
-keepclassmembers class * {
  static java.util.stream.Stream *();
  static java.lang.Iterable *();
  static java.util.Collection *();
  static java.util.List *();
  static java.lang.Object[] *();
  static java.lang.Object[][] *();
}
EOF
  fi
  services
  generated
} > "$config"

if ! java -cp "$proguard" proguard.ProGuard @"$config" > "$GATES_OUT/proguard-$kind.log" 2>&1; then
  if grep -q 'The output jar is empty' "$GATES_OUT/proguard-$kind.log"; then
    echo "dead-code ($kind): nothing is reachable. No entry point matched: an application keeps its main class or its" \
      "framework's entry points, a library its public API (config/dead-code/keep.pro)."
    exit "$FOUND_EXIT"
  fi
  cat "$GATES_OUT/proguard-$kind.log" >&2
  echo "dead-code: ProGuard failed (see above); a missing library usually means an incomplete classpath" >&2
  exit 2
fi

# ProGuard prints a class name, then its unused members indented. Drop inlined constants, compiler-made members, and
# the private no-argument constructor that exists to forbid instantiation.
unused="$(awk '
  /^[^ \t]/ { cls = $0; sub(/:$/, "", cls); if ($0 !~ /:$/) print cls " (the whole class)"; next }
  /static final (boolean|byte|char|short|int|long|float|double|java\.lang\.String) [^ ]+$/ { next }
  /lambda\$|access\$|\$values\(\)|\$deserializeLambda\$/ { next }
  /^[ \t]+([0-9]+:[0-9]+:)?private [A-Za-z0-9_$]+\(\)$/ { next }
  { line = $0; sub(/^[ \t]+([0-9]+:[0-9]+:)?/, "", line); print cls ": " line }
' "$usage")"
reached="$(grep -c . <<<"$PROGRAM") class directories"
if [[ -n "$unused" ]]; then
  printf '%s\n' "$unused"
  echo "dead-code ($kind): $(grep -c . <<<"$unused") unreachable, in $reached"
  exit "$FOUND_EXIT"
fi
echo "dead-code ($kind): nothing unreachable in $reached"
```

### 4.3 `scripts/TestReports.java`: every test class ran, and no test was skipped

Surefire only runs classes named `Test*`, `*Test`, `*Tests` or `*TestCase`, and a JUnit 4 test without the vintage engine never runs at all: both pass the build silently. A skipped test (`@Disabled`, a failed assumption, `@EnabledOnOs`) passes whatever the code does. This program reads every module's compiled test classes (with the JDK's class-file API) and JUnit XML reports, and fails on both.

```java
/*
 * Every test class ran, and no test was skipped. Reads each module's compiled test classes and the JUnit XML
 * reports Maven Surefire or Gradle wrote for them.
 *   never ran  a concrete class with JUnit test methods that no report mentions: a name the runner does not include,
 *              or a JUnit 4 test without the vintage engine.
 *   skipped    @Disabled, a failed assumption, @EnabledOnOs...: a skipped test passes whatever the code does.
 * Needs JDK 24+ (java.lang.classfile). Usage: java scripts/TestReports.java <repo dir>
 */
import java.io.IOException;
import java.lang.classfile.Annotation;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.MethodModel;
import java.lang.reflect.AccessFlag;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

final class TestReports {
  private static final Set<String> TEST_ANNOTATIONS = Set.of(
      "Lorg/junit/jupiter/api/Test;", "Lorg/junit/jupiter/params/ParameterizedTest;",
      "Lorg/junit/jupiter/api/RepeatedTest;", "Lorg/junit/jupiter/api/TestFactory;",
      "Lorg/junit/jupiter/api/TestTemplate;", "Lorg/junit/Test;");
  /** Where Maven and Gradle put compiled test classes, and where they write the XML reports of those classes. */
  private static final List<List<String>> LAYOUTS = List.of(
      List.of("target/test-classes", "target/surefire-reports"),
      List.of("build/classes/java/test", "build/test-results/test"));

  private final List<String> findings = new ArrayList<>();
  private int modules;
  private int testClasses;
  private int tests;

  public static void main(String[] args) throws Exception {
    Path root = Path.of(args.length > 0 ? args[0] : ".").toAbsolutePath().normalize();
    TestReports check = new TestReports();
    for (List<String> layout : LAYOUTS) {
      int depth = Path.of(layout.get(0)).getNameCount();
      for (Path classes : directoriesEndingWith(root, layout.get(0))) {
        Path module = classes;
        for (int i = 0; i < depth; i++) {
          module = module.getParent();
        }
        check.module(root, classes, module.resolve(layout.get(1)));
      }
    }
    System.out.printf("tests: %d modules, %d test classes, %d tests run%n", check.modules, check.testClasses, check.tests);
    check.findings.forEach(System.out::println);
    if (check.tests == 0) {
      System.out.println("tests: no test ran: run the tests first (./mvnw verify, ./gradlew check)");
    }
    System.exit(check.findings.isEmpty() && check.tests > 0 ? 0 : 1);
  }

  private void module(Path root, Path classes, Path reports) throws Exception {
    modules++;
    Set<String> ran = new HashSet<>();
    if (Files.isDirectory(reports)) {
      try (Stream<Path> files = Files.list(reports)) {
        for (Path report : files.filter(p -> p.getFileName().toString().matches("TEST-.*\\.xml")).sorted().toList()) {
          read(report, ran);
        }
      }
    }
    for (String testClass : testClassesIn(classes)) {
      testClasses++;
      if (!ran.contains(testClass)) {
        findings.add("never ran: " + testClass + " (" + root.relativize(classes) + "): Surefire runs Test*, *Test, *Tests"
            + " and *TestCase classes, and JUnit 4 tests need the vintage engine");
      }
    }
  }

  private void read(Path report, Set<String> ran) throws Exception {
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    NodeList cases = factory.newDocumentBuilder().parse(report.toFile()).getElementsByTagName("testcase");
    for (int i = 0; i < cases.getLength(); i++) {
      Element testCase = (Element) cases.item(i);
      String className = testCase.getAttribute("classname");
      ran.add(className);
      tests++;
      NodeList skipped = testCase.getElementsByTagName("skipped");
      if (skipped.getLength() > 0) {
        String message = ((Element) skipped.item(0)).getAttribute("message");
        findings.add("skipped: " + className + "." + testCase.getAttribute("name") + (message.isEmpty() ? "" : " (" + message + ")"));
      }
    }
  }

  private static Set<String> testClassesIn(Path classes) throws IOException {
    Set<String> found = new TreeSet<>();
    try (Stream<Path> files = Files.walk(classes)) {
      for (Path file : files.filter(p -> p.toString().endsWith(".class")).toList()) {
        ClassModel model = ClassFile.of().parse(Files.readAllBytes(file));
        boolean concrete = !model.flags().has(AccessFlag.ABSTRACT) && !model.flags().has(AccessFlag.INTERFACE);
        if (concrete && model.methods().stream().anyMatch(TestReports::isTest)) {
          found.add(model.thisClass().asInternalName().replace('/', '.'));
        }
      }
    }
    return found;
  }

  private static boolean isTest(MethodModel method) {
    return method.findAttribute(Attributes.runtimeVisibleAnnotations()).stream()
        .flatMap(attribute -> attribute.annotations().stream())
        .map(Annotation::className)
        .anyMatch(name -> TEST_ANNOTATIONS.contains(name.stringValue()));
  }

  private static List<Path> directoriesEndingWith(Path root, String suffix) throws IOException {
    Path end = Path.of(suffix);
    try (Stream<Path> paths = Files.walk(root, 8)) {
      return paths.filter(Files::isDirectory)
          .filter(p -> p.endsWith(end))
          .filter(p -> !p.toString().contains("node_modules"))
          .sorted()
          .toList();
    }
  }
}
```

### 4.4 `scripts/mutation-report.sh`: the change's lines, mutated against their tests

PIT mutates the bytecode of every production class the change touched and runs the tests that cover each mutant. The report lists the mutants that no test killed (`SURVIVED`) or that no test reached (`NO_COVERAGE`), on the lines the change added or changed. A class whose test alone changed is reported whole: a test change is the moment to ask what else the tests miss. It builds with `package` (tests skipped) before PIT, so a module's shared test jar is the filtered jar of Phase 3.5 and not its whole `test-classes`, and in measuring mode, so it runs on a tree that has not reached zero.

```bash
#!/usr/bin/env bash
# The mutation report of a change: PIT mutates every production class the change touched; this lists the mutants
# no test killed (SURVIVED) or reached (NO_COVERAGE), on the lines the change added or changed (a class whose test
# alone changed is listed whole). A report you act on before merging or releasing, not a gate.
#   scripts/mutation-report.sh <base-ref>            # e.g. origin/main, or the last release tag
#   scripts/mutation-report.sh <base-ref> --whole    # every changed class whole
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:?usage: $0 <base-ref> [--whole]}"
WHOLE="${2:-}"

changed_sources() {  # production sources the change touched, directly or through their test (FooTest -> Foo)
  git diff --name-only "$BASE" -- '*.java' | while IFS= read -r f; do
    case "$f" in
      src/main/java/*|*/src/main/java/*) if [[ -f "$f" ]]; then echo "$f"; fi ;;
      src/test/java/*|*/src/test/java/*)
        main="$(sed -E 's#src/test/java/#src/main/java/#; s#Tests?\.java$#.java#' <<<"$f")"
        if [[ -f "$main" ]]; then echo "$main"; fi ;;
    esac
  done | sort -u
}
class_of() { sed -E 's#^(.*/)?src/main/java/##; s#\.java$##; s#/#.#g' <<<"$1"; }
module_of() { local m="${1%%src/main/java/*}"; m="${m%/}"; echo "${m:-.}"; }

sources="$(changed_sources)"
if [[ -z "$sources" ]]; then echo "No production class changed since $BASE"; exit 0; fi
targets="$(for f in $sources; do class_of "$f"; done | paste -sd, -)"

if [[ -f pom.xml ]]; then
  out=target/gates
  # A report, not a gate: the other gates are skipped here so it also runs on a tree that has not reached zero.
  pit=(./mvnw -B -ntp package -Dmaven.test.skip.exec=true org.pitest:pitest-maven:mutationCoverage "-DtargetClasses=$targets"
    -Dgates.werror=-Xlint:all -Dgates.nullaway=WARN -Dgates.errorprone.extra=-XepAllErrorsAsWarnings
    -Dcheckstyle.skip -Dcpd.skip -Dpmd.skip -Dspotbugs.skip -Dmdep.analyze.skip -Denforcer.skip)
else
  out=build/gates
  pit=(./gradlew pitest "-Pgates.targetClasses=$targets" -Pgates.measure=true)
fi
echo "==> PIT on $targets (its log: $out/pit.log)"
mkdir -p "$out"
if ! "${pit[@]}" > "$out/pit.log" 2>&1; then
  tail -40 "$out/pit.log"
  echo "PIT failed: the tests must pass unmutated first" >&2
  exit 1
fi

for f in $sources; do
  cls="$(class_of "$f")"
  module="$(module_of "$f")"
  report=""
  for candidate in "$module/target/pit-reports/mutations.xml" "$module/build/reports/pitest/mutations.xml"; do
    if [[ -f "$candidate" ]]; then report="$candidate"; fi
  done
  if [[ -z "$report" ]]; then echo "--- $cls: no PIT report in $module (are its tests in $module?)"; continue; fi
  ranges=""
  if [[ "$WHOLE" != "--whole" ]] && ! git diff --quiet "$BASE" -- "$f"; then
    ranges="$(git diff --unified=0 "$BASE" -- "$f" | sed -nE 's/^@@ -[0-9,]+ \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p' \
      | awk '{ n = ($2 == "" ? 1 : $2); if (n > 0) printf "%d-%d ", $1, $1 + n - 1 }')"
    if [[ -z "$ranges" ]]; then echo "--- $cls: only deletions"; continue; fi
  fi
  echo "--- $cls (${ranges:-whole})"
  { grep -E "status='(SURVIVED|NO_COVERAGE)'" "$report" || true; } \
    | { grep -E '<mutatedClass>'"${cls//./\\.}"'(\$[^<]*)?</mutatedClass>' || true; } \
    | sed -E "s#.*status='([A-Z_]+)'.*<mutatedMethod>([^<]*)</mutatedMethod>.*<lineNumber>([0-9]+)</lineNumber>.*<description>([^<]*)</description>.*#\3 \1 \2: \4#" \
    | awk -v ranges="$ranges" '{
        keep = (ranges == ""); n = split(ranges, r, " ")
        for (i = 1; i <= n; i++) { split(r[i], b, "-"); if ($1 >= b[1] && $1 <= b[2]) keep = 1 }
        if (keep) print "    line " $0
      }'
done
```

Every mutant the report prints gets exactly one outcome before merge or release:
- a test that kills it;
- deleting the statement it proves has no effect;
- for an equivalent mutant (no test could ever tell it apart), the `@DoNotMutate` annotation below on the smallest method that holds it, with the reason. PIT skips any method or class that carries an annotation with that simple name.

`src/main/java/<ROOT_PKG as a path>/DoNotMutate.java` (create it the first time you need it, not before):

```java
package <ROOT_PKG>;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** PIT does not mutate what carries this annotation. Only for an equivalent mutant: say which, and why no test can see it. */
@Retention(RetentionPolicy.CLASS)
@Target({ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.TYPE})
public @interface DoNotMutate {
  /** The mutant, and why it is equivalent. */
  String value();
}
```

Do not run git commands that change the working tree (checkout, stash, commit) while PIT runs: it reads the compiled classes the build just wrote.

### 4.5 `scripts/validate.sh`: every gate, in order, each a hard stop

CI runs this script and nothing else.

```bash
#!/usr/bin/env bash
# Every gate, cheapest first; a green run here is a green CI run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# One command per step: under `set -e` a failure on the left of `&&` does not stop the script.
step() { printf '\n==> %s\n' "$1"; }

if [[ -f pom.xml ]]; then
  step "maven: enforcer, checkstyle, cpd, javac + error prone + nullaway, pmd, spotbugs, dependencies, tests"
  ./mvnw -B -ntp clean verify
else
  step "gradle: checkstyle, cpd, javac + error prone + nullaway, pmd, spotbugs, dependencies, tests"
  ./gradlew --no-configuration-cache clean check buildHealth
fi
step "every test class ran and none was skipped";  java scripts/TestReports.java .
step "the test JVMs' garbage collection";          java scripts/JfrGate.java --max-pause-ms 200 .
step "dead code: production";                      bash scripts/dead-code.sh --production
step "dead code: tests";                           bash scripts/dead-code.sh --tests

printf '\nvalidate: every gate passed\n'
```

Never add `-q` to the Maven step: quiet mode hides the compiler's and the dependency analysis' warnings, so a failure would print only "warnings found and -Werror specified".


---

## Phase 5: prove every gate works (mandatory)

On an existing codebase the gates already fail on today's findings, so a failure proves nothing about a plant. Add a scratch module first (a parent-inheriting `<module>` with one small class and its test, and `aspectjrt` if the repo weaves), prove that `./mvnw verify -pl <scratch-module>` is green with every gate enforcing, commit it in the scratch clone (the mutation row diffs against `HEAD`), and plant there. The CPD rows run from the root, and pass when the report names the scratch file. Delete the module when the table is done.

For each row: make the planted change in a scratch file (or a real file), run the gate, confirm it **fails with the message shown**, then revert it by deleting the scratch file or undoing exactly the lines you added. Put the table, with a ✔ per row, in your report. A row you cannot make fail means that gate is not wired: fix the wiring, not the row.

- `./mvnw -B -ntp verify` (**[gradle]** `./gradlew check buildHealth --continue`) runs every lifecycle gate; the script rows name their script. In a multi-module Maven build, run the lifecycle through `verify` (or at least `test-compile`), not `validate` alone: the enforcer resolves each module's dependencies, and a sibling module exists only once the reactor has built it.
- **javac's own warnings stop the compile before Error Prone looks**, so plant the javac rows and the Error Prone rows in separate runs.
- The messages are Maven's. Gradle prints the javac rows with their lint key (`warning: [cast] redundant cast to String`), CPD as `Found a 22 line (111 tokens) duplication in the following files:`, SpotBugs as `H P Dm: … forces garbage collection…`, and the dependency analysis as `Unused dependencies which should be removed:`.
- **[gradle]** Gradle runs every class with JUnit test methods whatever its name, so the "never ran" row needs a JUnit 4 test without the vintage engine there; the version-conflict row is `implementation` of an older version of a library another dependency brings (`Conflict found for module …: between versions …`).

| Gate | Plant this | Must fail with |
| --- | --- | --- |
| javac lint | `return (String) s;` where `s` is a `String` | `redundant cast to java.lang.String`, then `warnings found and -Werror specified` |
| javac lint | `List list = new ArrayList();` | `found raw type: java.util.List` |
| javac, JDK internals | a production class that reads `sun.misc.Unsafe.class` | `sun.misc.Unsafe is internal proprietary API and may be removed in a future release` |
| Error Prone | `name.trim();` as a statement | `[ReturnValueIgnored] Return value of 'trim' must be used` |
| Error Prone | `executor.submit(task);` as a statement | `[FutureReturnValueIgnored] Return value of methods returning Future must be checked` |
| Error Prone | a private method nothing calls (not named `unused…`) | `[UnusedMethod] Method '<name>' is never used.` |
| Error Prone | a list that is filled and never read | `[ModifiedButNotUsed] A collection or proto builder was created, but its values were never accessed.` |
| Error Prone | `catch (InterruptedException e) { }` | `[EmptyCatch] Caught exceptions should not be ignored` |
| Error Prone | `assertThat(total);` in a test, with no check after it | ``[CheckReturnValue] The result of `assertThat(...)` must be used`` |
| Error Prone | a non-static inner class that never uses its outer instance | `[ClassCanBeStatic] Inner class is non-static but does not reference enclosing class` |
| NullAway | `return names.get(key).length();` on a `Map<String, String>` | `[NullAway] dereferenced expression 'names.get(key)' is @Nullable` |
| NullAway | `return found.get();` on an `Optional` nothing checked | `[NullAway] Invoking get() on possibly empty Optional found` |
| Checkstyle | `@SuppressWarnings("NullAway")` on a method | `The warning 'NullAway' cannot be suppressed at this location. [SuppressWarnings]` |
| Checkstyle | `// NOPMD` at the end of a line | `Suppression marker: fix the finding.` |
| Checkstyle | a method named `unusedHelper` | `Name 'unusedHelper' must match pattern '^(?!unused)[a-z][a-zA-Z0-9_]*$'. [MethodName]` |
| Checkstyle | an unused import | `Unused import - java.util.List. [UnusedImports]` |
| Checkstyle | a method with 13 decision points | `Cyclomatic Complexity is 13 (max allowed is 12). [CyclomaticComplexity]` |
| PMD | `if (x > 0) { return true; } else { return false; }` | ``Rule:SimplifyBooleanReturns … This if statement can be replaced by `return {condition};`.`` |
| PMD | a private method with a parameter it never reads | `Rule:UnusedFormalParameter … Avoid unused method parameters such as 'factor'` |
| PMD | `static final Map<String, Integer> CACHE = new HashMap<>();` | `Rule:UnboundedStaticCollection … A static mutable collection lives as long as its class loader` |
| PMD | a `static final ThreadLocal` that is set and never removed (and, as the negative case, the same with `remove()` in a `finally`: no finding) | `Rule:ThreadLocalWithoutRemove … A ThreadLocal nothing ever removes` |
| PMD | `FileInputStream in = new FileInputStream(file); return in.read();` | `Rule:CloseResource … Ensure that resources like this FileInputStream object are closed after use.` |
| PMD | a test method that calls the code and asserts nothing | `Rule:UnitTestShouldIncludeAssert … This unit test should include assert() or fail().` |
| SpotBugs | `System.gc();` in production code | `forces garbage collection; extremely dubious except in benchmarking code [...] DM_GC` |
| CPD | copy a class's 20-line method verbatim into another module | `CPD Failure: Found 22 lines of duplicated code at locations:` with both files, then `CPD 7.28.0 has found 1 duplication` |
| CPD | the same copy into a test class of the same module | the same failure, naming the test file: tests and production code are one run |
| Dependencies | declare a dependency nothing uses | `Unused declared dependencies found:` and the dependency |
| Enforcer | set `<maxJdkVersion>` to `11` while a dependency is built for 17 | `EnforceBytecodeVersion failed with message: Found Banned Dependency: <the dependency>` |
| Enforcer | a `<plugin>` without a `<version>` | `RequirePluginVersions failed with message: Some plugins are missing valid versions` |
| Error Prone | a field `@GuardedBy("this")` read in a method that is not `synchronized` | `[GuardedBy] This access should be guarded by 'this', which is not currently held` |
| JfrGate | a module whose `<argLine>` does not start with `${gates.test.argLine}` (put `@{argLine}` back in one module's override and run its tests) | `jfr gate: test JVMs without a recording: 1 (first: <module>: its test JVM did not get the gated argLine …)` |
| JfrGate | remove `-XX:MetaspaceSize` from `gates.test.argLine` in a suite that loads more than about 21 MB of classes | `jfr gate: full collections forced by metaspace: <n>` |
| TestReports | rename a test class `PricingSpec` (the build stays green) | `never ran: <ROOT_PKG>.….PricingSpec (…): Surefire runs Test*, *Test, *Tests and *TestCase classes` |
| TestReports | `@Disabled("flaky on CI")` on a test (the build stays green) | `skipped: <class>.<method> (flaky on CI)` |
| NoThreadLeaks | in a module that gets the helpers from another one (3.5), a test that starts a `Thread` running for 30 s | `<TestClass> left threads running: [<thread name>]. Shut down every executor, timer and thread a test starts` |
| Collectability | a registry that also keeps every session it opens in a list, with a collectability test | `a closed session is still reachable after 5 s of collections: something keeps a reference to it` |
| AllocationBudget | rewrite the budgeted loop as a stream | `Expecting actual: 424L to be less than or equal to: 88L` (the numbers are yours) |
| Bounded heap | a test that keeps 1,000 arrays of 1 MB | `Terminating due to java.lang.OutOfMemoryError: Java heap space`, `The forked VM terminated without properly saying goodbye`, and `java_pid<pid>.hprof` in the module's build directory |
| JfrGate | a test (which passes) that keeps most of the old generation live in 64 KB arrays while allocating 1 MB ones: about 70 % of the heap under G1, 55 % under Serial (Serial's old generation is two thirds of the heap, and 70 % is an `OutOfMemoryError`) | `jfr gate: full collections nobody asked for: <n> (first: G1Full (G1 Compaction Pause), …)`, often with `G1 evacuation failures` too; under Serial `(first: SerialOld (Allocation Failure), …)` |
| dead-code production | an application: a public method that only a test calls. A library (its API is kept): a package-private method that only a test calls, and a public method of a class in an `internal` package that only a test calls | `<ROOT_PKG>.….Pricing: static long adjusted(int[])`, then `dead-code (main): 1 unreachable` and exit 3. A public method of a public API class is kept by the library rule and never reported: plant that one only in an application |
| dead-code production | remove the keep rule of a type Jackson (de)serializes | its accessors, one line each: the rule is what keeps them |
| dead-code tests | a class compiled from generated test sources (protobuf, Avro) that no test uses | nothing: `dead-code.sh` keeps generated classes whole |
| dead-code tests | a test fixture class nothing uses | `<ROOT_PKG>.….Baskets (the whole class)`, then `dead-code (test): 1 unreachable` |
| Mutation | an untested boundary in a changed line (`if (quantity > MAX_QUANTITY)` with no test at the maximum), then `scripts/mutation-report.sh HEAD` | `line <n> SURVIVED total: changed conditional boundary`; change only its test and the class is listed `(whole)` |

Also confirm that each gate **scanned what it should**, and record the numbers:
- the Maven reactor summary lists every module, and Checkstyle, PMD and SpotBugs run once per module (**[gradle]** a `checkstyle…`, `pmd…` and `spotbugsMain` task per project);
- `TestReports` prints modules, test classes and tests run; compare the test count with surefire's `Tests run:` lines;
- `JfrGate` prints how many recordings it read (one per module with tests), how many collections, and every gate's count;
- `dead-code.sh` prints how many class directories it read (one per module and kind);
- CPD: the cross-module and test-copy plants are the proof that it reads every module, production code and tests.

---

## Phase 6: baseline, then fix, in this order

Run every new rule once without failing, count the findings, and write the counts down. Then fix one group, turn it on, run `scripts/validate.sh`, and commit. The order goes from the cheapest group to the most invasive.

**[maven]**

```bash
# javac lint + Error Prone + NullAway, per check, without failing (the other lifecycle gates are skipped for this run)
./mvnw -B -ntp clean test-compile -Dgates.werror=-Xlint:all -Dgates.nullaway=WARN -Dgates.errorprone.extra=-XepAllErrorsAsWarnings \
  -Dcheckstyle.skip -Dcpd.skip -Denforcer.skip > /tmp/javac.log 2>&1
grep -E '\.java:\[[0-9]+,[0-9]+\] ' /tmp/javac.log | sort -u \
  | sed -E 's/.*\.java:\[[0-9]+,[0-9]+\] //; s/^([^[][^:]{0,39}).*/javac: \1/; s/^\[([A-Za-z]+)\].*/\1/' | sort | uniq -c | sort -rn
# PMD, Checkstyle, SpotBugs, CPD: their report goals do not fail; count their XML
./mvnw -B -ntp pmd:pmd checkstyle:checkstyle spotbugs:spotbugs pmd:aggregate-cpd > /tmp/reports.log 2>&1
cat $(find . -path '*/target/pmd.xml') | grep -oE 'rule="[A-Za-z]+"' | sort | uniq -c | sort -rn
cat $(find . -path '*/target/checkstyle-result.xml') | grep -oE 'source="[A-Za-z.]+"' | sed -E 's/.*\.([A-Za-z]+)"$/\1/' | sort | uniq -c | sort -rn
cat $(find . -path '*/target/spotbugsXml.xml') | grep -oE "<BugInstance [^>]*type='[A-Z0-9_]+'" | grep -oE "type='[A-Z0-9_]+'" | sort | uniq -c | sort -rn
grep -c '<duplication' target/cpd.xml
# dependencies, dead code, tests, the JDK
./mvnw -B -ntp test-compile dependency:analyze -Dcheckstyle.skip -Dcpd.skip -Denforcer.skip | grep -A30 -E 'Used undeclared|Unused declared'
bash scripts/dead-code.sh --production | tail -1; bash scripts/dead-code.sh --tests | tail -1
java scripts/TestReports.java . | head -1; bash scripts/jdk-report.sh
```

**[gradle]** `-Pgates.measure=true` turns every gate into a report for one run; count the same way from each project's reports (Error Prone's patch mode takes `-Pgates.errorprone.extra="-XepPatchChecks:… -XepPatchLocation:IN_PLACE"`):

```bash
./gradlew --no-configuration-cache clean check buildHealth --continue -Pgates.measure=true > /tmp/gradle.log 2>&1
grep -E '\.java:[0-9]+: warning: \[' /tmp/gradle.log | sort -u | sed -E 's/.*warning: \[([A-Za-z]+)\].*/\1/' | sort | uniq -c | sort -rn
cat $(find . -path '*/build/reports/pmd/*.xml') | grep -oE 'rule="[A-Za-z]+"' | sort | uniq -c | sort -rn
cat $(find . -path '*/build/reports/checkstyle/*.xml') | grep -oE 'source="[A-Za-z.]+"' | sed -E 's/.*\.([A-Za-z]+)"$/\1/' | sort | uniq -c | sort -rn
cat $(find . -path '*/build/reports/spotbugs/*.xml') | grep -oE '<BugInstance [^>]*type="[A-Z0-9_]+"' | grep -oE 'type="[A-Z0-9_]+"' | sort | uniq -c | sort -rn
grep -c '^Found a' /tmp/gradle.log
cat build/reports/dependency-analysis/build-health-report.txt
```

1. **Dead code, imports, dependencies and duplication**: the two dead-code passes, Error Prone `Unused*`, PMD `Unused*`, Checkstyle imports, dependency analysis, CPD. Delete what is dead. For what is really used but invisible to the tool (a framework entry point, a class named in a config file), add a keep rule with a comment naming its caller. Extract duplicates into a class with a specific name, never `Utils` or `Helper`. Put shared test data in fixtures under `src/test`.
2. **Logic that says more than it does**: javac lint, Error Prone `Unnecessary*`, `Redundant*`, `ModifiedButNotUsed`, `PatternMatchingInstanceof`, PMD `Simplify*`, `Unnecessary*`, `Useless*`, SpotBugs `RCN_*`, `UC_*`, `DLS_*`. Error Prone fixes much of it itself; review every change it makes:

   ```bash
   ./mvnw -B -ntp clean test-compile -Dgates.werror=-Xlint:all -Dgates.nullaway=WARN -Dcheckstyle.skip -Dcpd.skip -Denforcer.skip \
     "-Dgates.errorprone.extra=-XepPatchChecks:UnusedVariable,UnnecessaryParentheses,MissingOverride,UnnecessaryLambda,UnnecessaryMethodReference,PatternMatchingInstanceof,UnnecessaryBoxedVariable -XepPatchLocation:IN_PLACE"
   ```

   Error Prone rewrites the files in place and does not format what it writes ("Refactoring changes were successfully applied"): run the repo's formatter on the changed files, review the diff, and compile again.
3. **Errors that disappear, resources and concurrency**: the catch and throw rules, `CloseResource`, `MustBeClosedChecker`, `StreamResourceLeak`, `FutureReturnValueIgnored`, `InterruptedExceptionSwallowed`, SpotBugs' multithreading patterns.
4. **Tests that test**: PMD `UnitTest*`, Error Prone's test checks, `TestReports` (a class that never ran, a skipped test), `CheckReturnValue` on AssertJ.
5. **Types that do not lie**: NullAway, then `-Xlint:rawtypes,unchecked`, then `CheckOptionalEmptiness`. This is the largest group. If it has more than about 150 findings, split the tree into packages that do not overlap and give each worker the "how to fix" rules below; a package nobody has reached yet gets `@NullUnmarked` in its `package-info.java`, and that list only shrinks.
6. **Memory**: `UnboundedStaticCollection`, `ThreadLocalWithoutRemove`, `ClassCanBeStatic`, SpotBugs `MS_*`, `NoThreadLeaks`; then size the test JVM (Phase 3.1), write collectability tests for the objects that register themselves and allocation budgets for the hot paths (Phase 0), and run `JfrGate`.
7. **Mutation on the change**: run `scripts/mutation-report.sh <base>` on the branch. Kill, delete or mark every survivor.

### How to fix each kind (the rules that keep the fix from becoming new slop)

- **`map.get(k)` or another `@Nullable` read**: prefer a shape that cannot be `null`:
  - `getOrDefault(k, fallback)` or `computeIfAbsent(k, …)` when the fallback is what the code *should* do;
  - iterate `entrySet()` instead of looking keys up;
  - an `EnumMap` or a record instead of a map used as a struct.

  If absence is impossible and nothing sensible can replace the value, throw a small named exception (`throw new UnknownSkuException(sku)`). Never `requireNonNull` a value just to quiet NullAway, and never cast.
- **The same read in a test**: `Objects.requireNonNull(prices.get("apple"), "the fixture prices apple")` names the fixture when it is wrong, or assert the whole structure (`assertThat(prices).containsExactlyInAnyOrderEntriesOf(…)`).
- **A null check or guard the types say can never fire** (SpotBugs `RCN_*`, Error Prone `ImpossibleNullComparison`), first decide where the value comes from:
  - **It crosses a boundary** (a request body, JSON bound by Jackson, a system property, an environment variable, a column, a library without nullness annotations): keep the guard and make the type honest: `@Nullable` on the field or parameter.
  - **It is internal and already has that type**: delete the guard.
  - **Check the producer before deciding.** If a shared type lies, fix it at its source and list any you leave.
- **An ignored `Future`**: `join()` it when order matters; return it to a caller that does; or hand it to an owner that joins or cancels it on shutdown. A future whose failure nobody observes is a swallowed exception.
- **A resource** (`CloseResource`, `StreamResourceLeak`, `OBL_*`): try-with-resources, including the streams of `Files.lines`, `Files.list` and `Files.walk`.
- **A thread or executor** (`NoThreadLeaks`): the object that starts it owns it and shuts it down; `try (var executor = Executors.newVirtualThreadPerTaskExecutor()) { … }` for work that ends with the block.
- **A static collection** (`UnboundedStaticCollection`): a bounded cache (a `LinkedHashMap` with `removeEldestEntry`, or the repo's cache library with a maximum size), an instance field of an object with a lifecycle, or an immutable `Map.copyOf(…)` built once.
- **A `ThreadLocal`** (`ThreadLocalWithoutRemove`, `ThreadLocalUsage`): `static final`, and `remove()` in a `finally` around the work that set it; for request context, a `ScopedValue` (final since JDK 25).
- **An inner class that holds its outer instance** (`ClassCanBeStatic`): make it `static`. Since JDK 18 javac drops an outer reference the inner class never uses, which is why SpotBugs' `SIC_*` no longer fires on it; an anonymous class, a double-brace initialiser or a lambda that does use `this`, registered somewhere long-lived, still keeps the whole outer object alive.
- **An allocation budget exceeded**: find the site (`jfr view allocation-by-site`), then remove the allocation: a primitive instead of a wrapper, a loop instead of a stream on a hot path, a precompiled `Pattern` in a `static final`, no varargs or `String.format` per call. Never raise the budget.
- **Broad or empty `catch`**: catch the exception you can handle; otherwise let it propagate. Rethrow with the cause (`new FooException("…", e)`), and restore the interrupt flag (`Thread.currentThread().interrupt()`) when you catch `InterruptedException` and cannot rethrow it.
- **A cleanup that fails after the real failure** (a `finally`, or a catch that deletes a record, releases a lock, rolls back): the first exception is what the caller needs. Throw the cleanup's exception with the first one attached (`cleanupFailure.addSuppressed(original)`), or throw the original with the cleanup's attached; never let the cleanup's exception replace it with no trace.
- **A wrapper that hides what it wraps**: `catch (Throwable e) { throw new ConfigurationException("failed: " + e.getMessage()); }` drops the stack and names the wrong cause. Keep the cause, and pick the exception type from what failed, not from where it was caught.
- **A silent fallback on bad configuration** (an unknown algorithm name that falls back to MD5, a dimension that fails validation and is dropped): that is an error that disappears at the moment it is cheapest to see. Fail at configuration time with a named exception. Changing this changes behaviour (rule 5): report it with the fix, do not apply it.
- **A method only tests call** (a package-private `setClock`, `setHttpClient`, `resetForTests`): the gate reports it as dead, correctly. Give the production code the seam instead (a constructor or builder parameter that production passes too), and let the test use that. Do not add a keep rule for it.
- **An SPI method nothing calls** (an abstract method every implementation overrides and no caller invokes): delete it from the interface and every implementation, or report it if the interface is published API (removing it breaks callers outside the repo).
- **Shared mutable state** (Phase 2.10): `@Immutable`, a concurrent type, or `@GuardedBy` fields with the lock held on every access. A `LinkedHashMap` in access order changes on `get`, so a read needs the lock too.
- **A dead parameter** (`UnusedFormalParameter`): remove it from the signature and every caller. If an interface or framework requires it, that override is not reported.
- **Complexity over 12 or a method over 60 lines**: extract a well-named private method or a small class. Do not raise the limit.
- **A test the rules flag**: fix the test's shape (split it at four assertions, put a helper's assertion in a method named `assert…`). Never delete an assertion to pass a rule: move it into its own test. A skipped test is fixed or deleted with its reason in the commit, never left skipped.

---

## Phase 7: keep it (every future change)

- Run `scripts/validate.sh` before calling any change done. Green means every gate, not "mostly".
- Before merging or releasing, run `scripts/mutation-report.sh <base-ref>` and resolve every survivor it names (kill, delete, or mark as equivalent with `@DoNotMutate` and a reason). Write the survivor count and what you did about each into the PR or release notes.
- Adding code:
  - Make public only what another package uses.
  - A method or class only a test uses is dead.
  - Every object that registers itself somewhere gets a collectability test; every hot path gets an allocation budget.
  - An executor, thread, stream or connection has one owner that closes it.
  - An object more than one thread reaches is `@Immutable`, concurrent, or `@GuardedBy` (Phase 2.10).
  - A module that sets its own test `<argLine>` starts it with `${gates.test.argLine}`.
  - A catch that throws keeps the cause; a cleanup that fails keeps the first exception (`addSuppressed`).
  - No new `CPD-OFF` without its reason, no new keep rule or allowlist entry without its comment.
- Never raise a limit (complexity 12, nesting, 60-line methods, 500- and 900-line files, 4 assertions per test, 50-token clones, the test heap, an allocation budget, the pause bound). If something cannot fit, split it.
- Before a JDK upgrade, run `scripts/jdk-report.sh`. A production JDK upgrade changes `java.release` (**[gradle]** `gates.javaRelease`); a build JDK upgrade changes `requireJavaVersion` (**[gradle]** the `check` in the convention plugin) only once Error Prone supports that JDK. Re-measure the test JVM (Phase 3.1) after either.
- A finding that looks wrong is usually a type that lies, a missing entry point, or a real bug. Investigate it before adding a keep rule or an allowlist entry, and never add a suppression.

---

## Report (what you hand back)

Order every finding by tier, most severe first, and inside a tier by count. The tier is about what the finding can do in production, not which tool found it:

| Tier | What belongs in it | Examples |
| --- | --- | --- |
| **High** | can lose data, lose an error, crash, or run wrong in production; or no gate enforces anything | a swallowed or replaced exception, a silent fallback, an unsynchronized shared collection, a dereference of a value that can be `null` at a boundary, two versions of one library on the runtime classpath, gates not wired into CI |
| **Medium** | costs maintenance or resources, or will break on the next upgrade | duplication, complexity and size, mutable statics and `ThreadLocal`s, unclosed resources, dead code, JDK-internal APIs in dependencies, the test JVM outside its bounds, production JVM headroom |
| **Low** | says more than it does, or hides nothing yet | suppressions, test shape, unnecessary qualifiers, missing `@Override`, Javadoc tags, likely false positives of security detectors |

Every finding names file:line, the rule, and whether fixing it changes behaviour (rule 5). A finding you found by reading the code, with no gate behind it, says so, and says which gate would have caught it.

1. The **Phase 0 table** as filled in.
2. **What you installed**, with versions, and which files you created or changed.
3. The **Phase 5 proof table**, with ✔ per row and the scan counts.
4. The **Phase 6 baseline counts** per rule, before and after (after must be 0), and which fixes were automatic and which were by hand.
5. **Memory and the JDK**: the test JVM's measured live set, metaspace and chosen bounds; `JfrGate`'s output; every collectability test and allocation budget you added with its value; the production JVM measurement of Phase 3.8 and any change you propose; `jdk-report.sh`'s internal and removed APIs in dependencies.
6. **Every place you threw a named exception instead of falling back**, and every shared type you found lying, marked fixed or left (file:line and why).
7. The **mutation report's survivors** and the outcome for each.
8. **What you could not verify**, stated plainly.
9. **What this brief got wrong** on this repo: every block you had to change to make it work, and why. That list is how the brief improves.
