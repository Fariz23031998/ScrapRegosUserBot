# Android Gradle wrapper — use JDK 21 (JDK 22+ breaks AGP CMake/native builds).
$ErrorActionPreference = "Stop"

$candidates = @(
    "C:\Program Files\Java\jdk-21.0.10",
    "C:\Program Files\Eclipse Adoptium\jdk-21*",
    "C:\Program Files\Microsoft\jdk-21*",
    $env:ANDROID_JAVA_HOME,
    $env:JAVA_HOME
)

$jdkHome = $null
foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $resolved = $null
    if ($candidate -like "**") {
        $resolved = (Get-Item $candidate -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    } elseif (Test-Path $candidate) {
        $resolved = (Resolve-Path $candidate).Path
    }
    if ($resolved -and (Test-Path (Join-Path $resolved "bin\java.exe"))) {
        if ($resolved -match 'jdk-?21' -or $candidate -match 'jdk-?21') {
            $jdkHome = $resolved
            break
        }
        $prevErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $version = (& (Join-Path $resolved "bin\java.exe") -version 2>&1 | Out-String)
        $ErrorActionPreference = $prevErrorAction
        if ($version -match 'version "21') {
            $jdkHome = $resolved
            break
        }
    }
}

if (-not $jdkHome) {
    Write-Error @"
JDK 21 is required for Android builds. JDK 22+ fails with:
  configureCMakeRelWithDebInfo -> restricted method in java.lang.System

Install JDK 21 and set JAVA_HOME, or install to:
  C:\Program Files\Java\jdk-21.0.10
"@
    exit 1
}

$env:JAVA_HOME = $jdkHome
$env:PATH = "$jdkHome\bin;$env:PATH"

$androidDir = Join-Path $PSScriptRoot "..\android"
Push-Location $androidDir
try {
    & .\gradlew.bat @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
