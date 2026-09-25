<#
  selftest.ps1 -- exercises install\apply.ps1 / install\rollback.ps1 against a
  throwaway copy of the desktop profile with a fake package manager. The real
  profile is never touched: ProfileDir is overridden, APPDATA is redirected to
  a temp directory (so the dsh shim cannot be discovered) and PATH is prefixed
  with a fake pnpm.

  Run it with Windows PowerShell 5.1:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File test\selftest.ps1
#>
$ErrorActionPreference = 'Stop'

# Paths are derived from this file's location so the suite runs from any checkout.
# The throwaway sandbox lives in %TEMP%; the real desktop profile is only used as
# a template when it exists (see the setup section) and is never written to.
$RepoRoot    = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Join-Path (Get-Location) 'dsh-canvas-task-monitor' }
$Root        = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-ctm-selftest'
$ProfileDir  = Join-Path $Root 'profile'
$OriginalDir = Join-Path $Root 'original'
$TestDir     = Join-Path $RepoRoot 'test'
$FakeBin     = Join-Path $TestDir 'fakebin'
$ApplyScript = Join-Path $RepoRoot 'install\apply.ps1'
$RollbackScript = Join-Path $RepoRoot 'install\rollback.ps1'
$DshHome     = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$RealProfile = Join-Path $DshHome 'profiles\desktop'
$DepName     = 'dsh-canvas-task-monitor'
$SnapshotDir = Join-Path $ProfileDir '.dsh-ctm-snapshot'
$ProfileFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')

# The plugin package IS the repository root. The harness links a copy of it, so
# a broken fixture can never damage the published package and the test does not
# depend on the real profile having anything to do with the plugin directory.
$PluginFixture = Join-Path $Root 'plugin'
$PluginBroken  = Join-Path $Root 'plugin-broken'

$script:Passed = 0
$script:Failed = 0
function Check([string]$Name, $Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:Passed++
        Write-Host ("PASS  " + $Name) -ForegroundColor Green
    }
    else {
        $script:Failed++
        Write-Host ("FAIL  " + $Name + "   " + $Detail) -ForegroundColor Red
    }
}

function Invoke-Step([string]$Script, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $text = ''
    $code = -1
    try {
        # A native command's stderr becomes a terminating NativeCommandError
        # while ErrorActionPreference is Stop, which would abort this harness.
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1
        $code = $LASTEXITCODE
        $text = ($output | Out-String)
    }
    finally {
        $ErrorActionPreference = $saved
    }
    return [pscustomobject]@{ Code = $code; Text = $text }
}

function Get-Hashes([string]$Directory) {
    $map = @{}
    foreach ($name in $ProfileFiles) {
        $path = Join-Path $Directory $name
        if (Test-Path -LiteralPath $path) { $map[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
    }
    return $map
}

function Read-Json([string]$Path) { return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json }
function Read-Raw([string]$Path) { return (Get-Content -LiteralPath $Path -Raw) }
function Write-Raw([string]$Path, [string]$Text) {
    # UTF-8 without a BOM: pnpm (and the scripts under test) must be able to read it.
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-ArgLog([string]$Path) {
    # PowerShell 5.1's ConvertFrom-Json does not enumerate the array it returns,
    # so pipe the result through ForEach-Object to get real elements.
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) | ForEach-Object { $_ })
}

# ------------------------------------------------------------------ setup ---
if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
New-Item -ItemType Directory -Path $OriginalDir -Force | Out-Null
foreach ($name in $ProfileFiles) {
    $template = Join-Path $RealProfile $name
    if (Test-Path -LiteralPath $template) {
        Copy-Item -LiteralPath $template -Destination (Join-Path $ProfileDir $name) -Force
        Copy-Item -LiteralPath $template -Destination (Join-Path $OriginalDir $name) -Force
    }
    else {
        # No DSH profile on this machine: synthesize a minimal, plausible one.
        # Nothing here is asserted beyond byte-for-byte restore, so shape is all
        # that matters; the bundle list keeps the "@deepseek-ai/dsh-base first"
        # ordering the install script enforces.
        $body = switch ($name) {
            'package.json' {
                @{
                    name         = 'desktop'
                    private      = $true
                    dependencies = @{}
                    dsh          = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
                } | ConvertTo-Json -Depth 10
            }
            'pnpm-lock.yaml' { "lockfileVersion: '9.0'`nsettings:`n  autoInstallPeers: false`n" }
            'pnpm-workspace.yaml' { "packages:`n  - .`n" }
            'cordis.patch.yml' { "- id: modlens`n  name: '@liustack/modlens'`n" }
            default { '' }
        }
        Write-Raw (Join-Path $ProfileDir $name) $body
        Write-Raw (Join-Path $OriginalDir $name) $body
    }
}

# The template is taken from the real profile, which may already carry this
# plugin (it does once apply.bat has been run for real). Strip those traces so
# the fixture always starts from the pre-install state; profile and original get
# the identical treatment, which keeps the byte-for-byte comparisons meaningful.
foreach ($directory in @($ProfileDir, $OriginalDir)) {
    $path = Join-Path $directory 'package.json'
    $json = Read-Json $path
    if ($null -ne $json.dependencies.PSObject.Properties[$DepName]) {
        $json.dependencies.PSObject.Properties.Remove($DepName)
    }
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $DepName })
    Write-Raw $path ($json | ConvertTo-Json -Depth 10)
}

# The plugin fixture: a copy of the repository root, which is the plugin package.
# package.json and cordis.patch.yml are the published ones; lib\ is copied when
# it is present and stubbed otherwise, so this harness stays runnable while the
# plugin's own lib/ is still being written.
New-Item -ItemType Directory -Path $PluginFixture -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PluginFixture 'lib') -Force | Out-Null
foreach ($relative in @('package.json', 'cordis.patch.yml')) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $relative) -Destination (Join-Path $PluginFixture $relative) -Force
}
$stubbed = @()
foreach ($relative in @('lib\index.js', 'lib\client.js')) {
    $source = Join-Path $RepoRoot $relative
    $target = Join-Path $PluginFixture $relative
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    else {
        Set-Content -LiteralPath $target -Encoding ASCII -Value ('// placeholder for ' + $relative + ' (written by the plugin build)')
        $stubbed += $relative
    }
}

# A fixture whose lib\client.js is missing, used to prove the preflight check
# that replaced the old Python checks actually fires.
New-Item -ItemType Directory -Path (Join-Path $PluginBroken 'lib') -Force | Out-Null
foreach ($relative in @('package.json', 'cordis.patch.yml', 'lib\index.js')) {
    Copy-Item -LiteralPath (Join-Path $PluginFixture $relative) -Destination (Join-Path $PluginBroken $relative) -Force
}

$env:FAKE_PROFILE = $ProfileDir
$env:FAKE_PLUGIN_DIR = $PluginFixture
$env:APPDATA = Join-Path $Root 'appdata'
New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null

# The real dsh shim lives in a DSH Desktop host-commands directory that is on
# PATH in an interactive shell. Strip it so the test cannot possibly reach the
# real profile through the dsh channel, and leave only the fake pnpm.
$pathParts = @($env:PATH -split ';' | Where-Object { $_ -ne '' -and $_ -notmatch 'DSH Desktop' })
$env:PATH = (@($FakeBin) + $pathParts) -join ';'
$SanitizedPath = $env:PATH
Remove-Item Env:\FAKE_PNPM_FAIL -ErrorAction SilentlyContinue

# Two fake dsh shims: one that claims the profile this copy actually is (its
# directory is named "profile"), one that claims a different profile so the
# guard inside the scripts has to reject it.
$FakeDshBin = Join-Path $Root 'bin-dsh'
$FakeDshOtherBin = Join-Path $Root 'bin-dsh-other'
foreach ($pair in @(@($FakeDshBin, 'profile'), @($FakeDshOtherBin, 'other'))) {
    $bin = $pair[0]
    $value = $pair[1]
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $lines = @(
        '@echo off',
        ('set "DSH_DESKTOP_DEFAULT_PROFILE=' + $value + '"'),
        ('set "DSH_HOME=' + $DshHome + '"'),
        ('node "' + (Join-Path $TestDir 'fake-dsh.mjs') + '" %*'),
        'exit /b %ERRORLEVEL%'
    )
    Set-Content -LiteralPath (Join-Path $bin 'dsh.cmd') -Value $lines -Encoding ASCII
}
$env:FAKE_DSH_LOG = Join-Path $Root 'fake-dsh-args.json'
$env:FAKE_PNPM_LOG = Join-Path $Root 'fake-pnpm-args.json'

# A shim reachable only through the %APPDATA% recursion -- that branch returns a
# FileInfo, which has no Source property at all. Dereferencing .Source there
# aborted apply.ps1 on the real machine.
$AppDataDsh = Join-Path $Root 'appdata-dsh'
$GenBin = Join-Path $AppDataDsh 'DSH Desktop\host-commands\gen1\bin'
New-Item -ItemType Directory -Path $GenBin -Force | Out-Null
Set-Content -LiteralPath (Join-Path $GenBin 'dsh.cmd') -Encoding ASCII -Value @(
    '@echo off',
    'set "DSH_DESKTOP_DEFAULT_PROFILE=profile"',
    ('node "' + (Join-Path $TestDir 'fake-dsh.mjs') + '" %*'),
    'exit /b %ERRORLEVEL%'
)

# A pnpm reachable only through the %APPDATA% candidate list -- also a FileInfo,
# and exactly how the real machine finds pnpm.
$AppDataPnpm = Join-Path $Root 'appdata-pnpm'
$NpmDir = Join-Path $AppDataPnpm 'npm'
New-Item -ItemType Directory -Path $NpmDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $NpmDir 'pnpm.cmd') -Encoding ASCII -Value @(
    '@echo off',
    ('node "' + (Join-Path $TestDir 'fake-pnpm.mjs') + '" %*'),
    'exit /b %ERRORLEVEL%'
)

# A PATH variant with no pnpm on it, so Find-PnpmCommand has to fall through to
# its %APPDATA% candidate list.
$PathNoPnpm = (@($pathParts | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $_ 'pnpm.cmd')) -and
            -not (Test-Path -LiteralPath (Join-Path $_ 'pnpm.exe')) -and
            -not (Test-Path -LiteralPath (Join-Path $_ 'pnpm'))
        })) -join ';'

Check 'PATH has no dsh, so the pnpm channel is exercised' `
    ($null -eq (Get-Command -Name 'dsh' -CommandType Application -ErrorAction SilentlyContinue))

# A DSH Desktop runtime pnpm shim, laid out exactly like the real one. The
# scripts must prefer it over the pnpm on PATH, and must put its directory first
# on PATH -- that is what gives `dsh plugin` the Desktop policy, since dsh
# resolves pnpm from PATH (dsh/lib/plugin-*.js: spawnSync("pnpm")).
$AppDataRuntime = Join-Path $Root 'appdata-runtime'
$RuntimeBin = Join-Path $AppDataRuntime 'DSH Desktop\runtime-commands\generations\gen1\bin'
New-Item -ItemType Directory -Path $RuntimeBin -Force | Out-Null
$PathProbe = Join-Path $Root 'runtime-path.txt'
Set-Content -LiteralPath (Join-Path $RuntimeBin 'pnpm.cmd') -Encoding ASCII -Value @(
    '@echo off',
    ('echo "%PATH%" > "' + $PathProbe + '"'),
    ('node "' + (Join-Path $TestDir 'fake-pnpm.mjs') + '" %*'),
    'exit /b %ERRORLEVEL%'
)

$originalHashes = Get-Hashes -Directory $OriginalDir
$originalPackage = Read-Json (Join-Path $OriginalDir 'package.json')
$originalBundleCount = @($originalPackage.dsh.profile.bundles).Count
Write-Host ("setup: profile copy at " + $ProfileDir + " (" + $originalBundleCount + " bundles, " + $originalHashes.Count + " files)")
Write-Host ("setup: plugin fixture at " + $PluginFixture + " (stubbed: " + (@($stubbed) -join ', ') + ")")

# --------------------------------------------------------------------- T0 ---
# The preflight checks that replaced the old Python-project checks.
Check 'T0 the fixture plugin package has all four required files' `
    (@(@('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js') |
        Where-Object { -not (Test-Path -LiteralPath (Join-Path $PluginFixture $_)) }).Count -eq 0)

$t0 = Invoke-Step $ApplyScript @('-DryRun', '-ProfileDir', $ProfileDir, '-PluginDir', $PluginBroken)
Check 'T0 a plugin package missing lib\client.js is refused' ($t0.Code -eq 1) ("code=" + $t0.Code + " :: " + $t0.Text)
Check 'T0 the refusal names the missing plugin file' ($t0.Text -match 'plugin file missing') ("text=" + $t0.Text)
Check 'T0 the refusal created no snapshot' (-not (Test-Path -LiteralPath $SnapshotDir))

$t0b = Invoke-Step $ApplyScript @('-DryRun', '-ProfileDir', $ProfileDir, '-PluginDir', (Join-Path $Root 'no-such-plugin'))
Check 'T0 a missing plugin directory is refused' (($t0b.Code -eq 1) -and ($t0b.Text -match 'plugin package directory not found'))

# Static guards: the old install machinery verified a Python project
# (canvas_task_monitor / bridge_main.py / .venv), and the new plugin has no
# Python half at all, so no such path or check may survive. The header comment
# is allowed to say "no Python" -- what must not survive is any concrete
# reference to that project. Every script in install\ must also stay ASCII-only
# (PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
$applyText = Read-Raw $ApplyScript
$rollbackText = Read-Raw $RollbackScript
$stalePattern = '(?i)canvas_task_monitor|bridge_main|python\.exe|\.venv|projectdir'
$applyStale = [regex]::Match($applyText, $stalePattern)
$rollbackStale = [regex]::Match($rollbackText, $stalePattern)
Check 'T0 apply.ps1 keeps no reference to the old Python project' `
    (-not $applyStale.Success) ("matched: " + $applyStale.Value)
Check 'T0 rollback.ps1 keeps no reference to the old Python project' `
    (-not $rollbackStale.Success) ("matched: " + $rollbackStale.Value)
Check 'T0 apply.ps1 is ASCII-only' (-not ($applyText -match '[^\x00-\x7F]'))
Check 'T0 rollback.ps1 is ASCII-only' (-not ($rollbackText -match '[^\x00-\x7F]'))
Check 'T0 apply.ps1 derives -PluginDir from its own location' `
    ($applyText -match [regex]::Escape('$(Split-Path -Parent $PSScriptRoot)'))
Check 'T0 the default profile resolves from DSH_HOME in apply.ps1' `
    ($applyText -match [regex]::Escape('$env:DSH_HOME'))
Check 'T0 the default profile resolves from DSH_HOME in rollback.ps1' `
    ($rollbackText -match [regex]::Escape('$env:DSH_HOME'))
# A published package must not ship one machine's profile path as its default.
Check 'T0 neither script hard-codes a C:\Users path' `
    (-not ($applyText -match 'C:\\Users') -and -not ($rollbackText -match 'C:\\Users'))
Check 'T0 apply.ps1 keeps the Desktop pnpm policy argument' `
    ($applyText -match [regex]::Escape("'--config.minimumReleaseAge=0'"))

# --------------------------------------------------------------------- T1 ---
$before = Get-Hashes -Directory $ProfileDir
$t1 = Invoke-Step $ApplyScript @('-DryRun', '-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T1 dry run exits 0' ($t1.Code -eq 0) ("code=" + $t1.Code + " :: " + $t1.Text)
Check 'T1 dry run announces itself' ($t1.Text -match 'DRY RUN')
Check 'T1 dry run names the plugin package' ($t1.Text -match 'plugin  : ')
Check 'T1 dry run made no snapshot' (-not (Test-Path -LiteralPath $SnapshotDir))
$after = Get-Hashes -Directory $ProfileDir
$unchanged = $true
foreach ($name in $before.Keys) { if ($before[$name] -ne $after[$name]) { $unchanged = $false } }
Check 'T1 dry run left every file untouched' $unchanged

# --------------------------------------------------------------------- T2 ---
$t2 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T2 apply exits 0' ($t2.Code -eq 0) ("code=" + $t2.Code + " :: " + $t2.Text)
Check 'T2 used the pnpm channel' ($t2.Text -match 'channel : pnpm add')
Check 'T2 installer actually ran' ($t2.Text -match 'fake pnpm: added')
$args2 = Read-ArgLog $env:FAKE_PNPM_LOG
Check 'T2 pnpm receives the Desktop policy argument first' `
    (($args2.Count -ge 2) -and ($args2[0] -eq '--config.minimumReleaseAge=0')) ("args=" + ($args2 -join ' '))
Check 'T2 pnpm receives the link spec of the plugin package' `
    ($args2 -contains ('link:' + $PluginFixture.Replace('\', '/'))) ("args=" + ($args2 -join ' '))

$pkg = Read-Json (Join-Path $ProfileDir 'package.json')
$bundles = @($pkg.dsh.profile.bundles)
Check 'T2 dependency recorded' ($null -ne $pkg.dependencies.PSObject.Properties[$DepName])
Check 'T2 bundle appended' ($bundles -contains $DepName)
Check 'T2 bundle appended last' ($bundles[-1] -eq $DepName)
Check 'T2 bundle count grew by exactly one' ($bundles.Count -eq $originalBundleCount + 1)
Check 'T2 first bundle is still @deepseek-ai/dsh-base' ($bundles[0] -eq '@deepseek-ai/dsh-base')
Check 'T2 existing bundles kept in order' `
    ((@($originalPackage.dsh.profile.bundles) -join ',') -eq (($bundles | Select-Object -First $originalBundleCount) -join ','))

$patch = Read-Raw (Join-Path $ProfileDir 'cordis.patch.yml')
$originalPatch = Read-Raw (Join-Path $OriginalDir 'cordis.patch.yml')
Check 'T2 profile cordis.patch.yml left byte-identical' ($patch -ceq $originalPatch)
Check 'T2 no loader entry written into the profile patch' `
    (-not ($patch -match '(?m)^\s*-\s*id:\s*canvas-task-monitor\s*$'))
Check 'T2 pre-existing modlens patch kept' ($patch -match '(?m)^\s*-\s*id:\s*modlens\s*$')
Check 'T2 snapshot created' (Test-Path -LiteralPath (Join-Path $SnapshotDir 'package.json'))
Check 'T2 snapshot manifest written' (Test-Path -LiteralPath (Join-Path $SnapshotDir 'snapshot.json'))
$manifest = Read-Json (Join-Path $SnapshotDir 'snapshot.json')
Check 'T2 manifest names the plugin' ($manifest.plugin -eq $DepName)
Check 'T2 manifest records the linked plugin directory' ($manifest.pluginDir -eq $PluginFixture)
Check 'T2 manifest records the dependency spec' `
    ($manifest.dependencyValue -eq ('link:' + $PluginFixture.Replace('\', '/')))
Check 'T2 manifest carries no Python project directory' ($null -eq $manifest.PSObject.Properties['projectDir'])
Check 'T2 node_modules link created' (Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$DepName\package.json"))
Check 'T2 verification passed' ($t2.Text -match 'apply finished')

# --------------------------------------------------------------------- T3 ---
$t3 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T3 second apply is refused' ($t3.Code -eq 1) ("code=" + $t3.Code)
Check 'T3 refusal names the snapshot' ($t3.Text -match 'snapshot already exists')

# --------------------------------------------------------------------- T4 ---
$t4 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T4 rollback exits 0' ($t4.Code -eq 0) ("code=" + $t4.Code + " :: " + $t4.Text)
Check 'T4 used the pnpm channel' ($t4.Text -match 'channel : pnpm install')
Check 'T4 snapshot removed' (-not (Test-Path -LiteralPath $SnapshotDir))
Check 'T4 node_modules link pruned' (-not (Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$DepName")))
$restored = Read-Json (Join-Path $ProfileDir 'package.json')
Check 'T4 dependency removed' ($null -eq $restored.dependencies.PSObject.Properties[$DepName])
Check 'T4 bundle entry removed' (-not (@($restored.dsh.profile.bundles) -contains $DepName))
$restoredPatch = Read-Raw (Join-Path $ProfileDir 'cordis.patch.yml')
Check 'T4 patch entry removed' (-not ($restoredPatch -match '(?m)^\s*-\s*id:\s*canvas-task-monitor\s*$'))
$currentHashes = Get-Hashes -Directory $ProfileDir
$identical = $true
foreach ($name in $originalHashes.Keys) { if ($originalHashes[$name] -ne $currentHashes[$name]) { $identical = $false; Write-Host ("      differs: " + $name) } }
Check 'T4 restored files are byte-identical to the originals' $identical

# --------------------------------------------------------------------- T5 ---
$t5 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T5 second rollback exits 0' ($t5.Code -eq 0) ("code=" + $t5.Code)
Check 'T5 second rollback is a no-op' ($t5.Text -match 'nothing to roll back')

# --------------------------------------------------------------------- T6 ---
Copy-Item -LiteralPath (Join-Path $OriginalDir 'package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
$partial = Read-Json (Join-Path $ProfileDir 'package.json')
$partial.dependencies | Add-Member -NotePropertyName $DepName -NotePropertyValue 'link:D:/somewhere' -Force
$partial | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Encoding UTF8
$t6 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T6 partial state is refused' ($t6.Code -eq 1) ("code=" + $t6.Code)
Check 'T6 refusal explains partial state' ($t6.Text -match 'partially patched')
Check 'T6 refusal created no snapshot' (-not (Test-Path -LiteralPath $SnapshotDir))

# --------------------------------------------------------------------- T7 ---
Copy-Item -LiteralPath (Join-Path $OriginalDir 'package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
$env:FAKE_PNPM_FAIL = '1'
$t7 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T7 failing installer exits 1' ($t7.Code -eq 1) ("code=" + $t7.Code)
Check 'T7 failure message points at rollback' ($t7.Text -match 'run rollback.bat')
Check 'T7 snapshot kept after the failure' (Test-Path -LiteralPath (Join-Path $SnapshotDir 'package.json'))
Remove-Item Env:\FAKE_PNPM_FAIL

$t8 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T8 rollback after a failed apply exits 0' ($t8.Code -eq 0) ("code=" + $t8.Code + " :: " + $t8.Text)
Check 'T8 snapshot removed again' (-not (Test-Path -LiteralPath $SnapshotDir))
$finalHashes = Get-Hashes -Directory $ProfileDir
$finalIdentical = $true
foreach ($name in $originalHashes.Keys) { if ($originalHashes[$name] -ne $finalHashes[$name]) { $finalIdentical = $false } }
Check 'T8 profile is byte-identical to the original again' $finalIdentical
$t9 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T9 third rollback still a no-op' (($t9.Code -eq 0) -and ($t9.Text -match 'nothing to roll back'))

# -------------------------------------------------------------------- T10 ---
# A dsh shim that belongs to a different profile must be refused, and the
# script must fall back to the plain package manager.
$env:PATH = (@($FakeDshOtherBin) + @($SanitizedPath)) -join ';'
$t10 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T10 shim for another profile is rejected' ($t10.Text -match 'ignoring dsh shim at')
Check 'T10 falls back to the pnpm channel' ($t10.Text -match 'channel : pnpm add')
Check 'T10 apply still succeeds' ($t10.Code -eq 0) ("code=" + $t10.Code + " :: " + $t10.Text)
$t11 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T11 rollback with the wrong shim exits 0' ($t11.Code -eq 0) ("code=" + $t11.Code + " :: " + $t11.Text)
Check 'T11 rollback skips the wrong shim' ($t11.Text -match 'skipping the dsh shim at')

# -------------------------------------------------------------------- T12 ---
# The production channel: a shim that does claim the desktop profile.
$env:PATH = (@($FakeDshBin) + @($SanitizedPath)) -join ';'
Remove-Item -LiteralPath $env:FAKE_DSH_LOG -ErrorAction SilentlyContinue
$t12 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T12 desktop shim is selected' ($t12.Text -match 'channel : dsh plugin add')
Check 'T12 apply via dsh exits 0' ($t12.Code -eq 0) ("code=" + $t12.Code + " :: " + $t12.Text)
$log = Read-ArgLog $env:FAKE_DSH_LOG
Check 'T12 dsh received plugin --profile profile add <spec>' `
    (($log.Count -eq 5) -and ($log[0] -eq 'plugin') -and ($log[1] -eq '--profile') -and ($log[2] -eq 'profile') -and ($log[3] -eq 'add') -and ($log[4] -like 'link:*')) `
    ("log=" + ($log -join ' '))

# `dsh plugin add` reconciles dsh.profile.bundles itself (the fake does too, via
# FAKE_PNPM_RECONCILE), so apply.ps1 has to notice and not append a second row.
$pkg12 = Read-Json (Join-Path $ProfileDir 'package.json')
$bundles12 = @($pkg12.dsh.profile.bundles)
$dupes12 = @($bundles12 | Where-Object { $_ -eq $DepName })
Check 'T12 reconcile did not duplicate the bundle entry' ($dupes12.Count -eq 1) ("count=" + $dupes12.Count)
Check 'T12 bundle still appended last' ($bundles12[-1] -eq $DepName)
Check 'T12 apply noticed the reconcile' ($t12.Text -match 'already lists')

Remove-Item -LiteralPath $env:FAKE_DSH_LOG -ErrorAction SilentlyContinue
$t13 = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T13 rollback via dsh exits 0' ($t13.Code -eq 0) ("code=" + $t13.Code + " :: " + $t13.Text)
Check 'T13 rollback uses the dsh channel' ($t13.Text -match 'channel : dsh plugin install')
$log2 = Read-ArgLog $env:FAKE_DSH_LOG
Check 'T13 dsh received plugin --profile profile install' `
    (($log2.Count -eq 4) -and ($log2[3] -eq 'install')) ("log=" + ($log2 -join ' '))
$env:PATH = $SanitizedPath
$finalHashes2 = Get-Hashes -Directory $ProfileDir
$identical2 = $true
foreach ($name in $originalHashes.Keys) { if ($originalHashes[$name] -ne $finalHashes2[$name]) { $identical2 = $false } }
Check 'T13 profile is byte-identical to the original again' $identical2

# -------------------------------------------------------------------- T14 ---
# The shim is only reachable through the %APPDATA% recursion (FileInfo branch).
$env:APPDATA = $AppDataDsh
Remove-Item -LiteralPath $env:FAKE_DSH_LOG -ErrorAction SilentlyContinue
$t14 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T14 APPDATA-discovered shim is used' ($t14.Text -match 'channel : dsh plugin add') ("code=" + $t14.Code + " :: " + $t14.Text)
Check 'T14 apply via the discovered shim exits 0' ($t14.Code -eq 0) ("code=" + $t14.Code + " :: " + $t14.Text)
Check 'T14 no missing-property crash' (-not ($t14.Text -match 'cannot be found'))
$log3 = Read-ArgLog $env:FAKE_DSH_LOG
$t14ok = ($log3.Count -eq 5) -and ($log3[3] -eq 'add')
Check 'T14 the discovered shim received the add command' $t14ok ("log=" + ($log3 -join ' '))
$t14b = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T14 rollback exits 0' ($t14b.Code -eq 0) ("code=" + $t14b.Code + " :: " + $t14b.Text)

# -------------------------------------------------------------------- T15 ---
# pnpm is only reachable through the %APPDATA% candidate list (FileInfo branch).
$env:APPDATA = $AppDataPnpm
$env:PATH = $PathNoPnpm
$t15 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T15 APPDATA-discovered pnpm is used' ($t15.Text -match 'channel : pnpm add') ("code=" + $t15.Code + " :: " + $t15.Text)
Check 'T15 apply via the discovered pnpm exits 0' ($t15.Code -eq 0) ("code=" + $t15.Code + " :: " + $t15.Text)
Check 'T15 no missing-property crash' (-not ($t15.Text -match 'cannot be found'))
$t15b = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T15 rollback exits 0' ($t15b.Code -eq 0) ("code=" + $t15b.Code + " :: " + $t15b.Text)

# -------------------------------------------------------------------- T16 ---
# The Desktop runtime shim must win over the pnpm on PATH, and its directory
# must end up first on PATH.
$env:APPDATA = $AppDataRuntime
$env:PATH = $SanitizedPath
Remove-Item -LiteralPath $PathProbe -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:FAKE_PNPM_LOG -ErrorAction SilentlyContinue
$t16 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T16 Desktop runtime shim is preferred' ($t16.Text -match 'Desktop runtime shim') ("code=" + $t16.Code + " :: " + $t16.Text)
Check 'T16 apply through the shim exits 0' ($t16.Code -eq 0) ("code=" + $t16.Code + " :: " + $t16.Text)
Check 'T16 used the pnpm channel' ($t16.Text -match 'channel : pnpm add')
Check 'T16 the shim itself ran' ($t16.Text -match 'fake pnpm: added')
$probe = ''
if (Test-Path -LiteralPath $PathProbe) { $probe = Read-Raw $PathProbe }
$firstOnPath = ''
if ($probe -match '^"?([^;"]+)') { $firstOnPath = $Matches[1] }
Check 'T16 the shim directory is first on PATH' ($firstOnPath -eq $RuntimeBin) ("first=" + $firstOnPath)
$args16 = Read-ArgLog $env:FAKE_PNPM_LOG
Check 'T16 the policy argument reaches pnpm' `
    (($args16.Count -ge 2) -and ($args16[0] -eq '--config.minimumReleaseAge=0')) ("args=" + ($args16 -join ' '))
$t16b = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T16 rollback exits 0' ($t16b.Code -eq 0) ("code=" + $t16b.Code + " :: " + $t16b.Text)

# -------------------------------------------------------------------- T17 ---
# A stale node_modules entry must not survive a rollback. The hoisted linker
# does not remove an existing `link:` junction when the dependency disappears
# from package.json -- that is exactly what made the first real-machine rollback
# fail its own verification ("... still exists after the package manager run").
# fake-pnpm.mjs models that behaviour now, so this case only passes when
# rollback removes the leftover entry itself instead of trusting pnpm.
$env:APPDATA = Join-Path $Root 'appdata'
$env:PATH = $SanitizedPath
$linkedDir = Join-Path $ProfileDir "node_modules\$DepName"
$t17 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T17 apply exits 0' ($t17.Code -eq 0) ("code=" + $t17.Code + " :: " + $t17.Text)
Check 'T17 the link is in place before the rollback' (Test-Path -LiteralPath (Join-Path $linkedDir 'package.json'))
$t17b = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T17 rollback exits 0 although pnpm left the link behind' ($t17b.Code -eq 0) ("code=" + $t17b.Code + " :: " + $t17b.Text)
Check 'T17 rollback removed the leftover entry itself' ($t17b.Text -match 'removing the stale link') ("text=" + $t17b.Text)
Check 'T17 the node_modules entry is gone' (-not (Test-Path -LiteralPath $linkedDir))
Check 'T17 the snapshot is gone' (-not (Test-Path -LiteralPath $SnapshotDir))

# -------------------------------------------------------------------- T18 ---
# A link that resolves to another package must never be accepted. The previous
# plugin lived in a different directory under the same package name, and the
# linked manifest declares dsh.bundle.patch just like this one -- so a check that
# only reads that manifest lets DSH load the old code. $PluginBroken is exactly
# that shape: same name, same version, built from the same package.json.
Copy-Item -LiteralPath (Join-Path $OriginalDir 'package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
$t18Json = Read-Json (Join-Path $ProfileDir 'package.json')
$t18Json.dependencies | Add-Member -NotePropertyName $DepName -NotePropertyValue 'link:D:/somewhere-else' -Force
$t18Json.dsh.profile.bundles = @($t18Json.dsh.profile.bundles) + @($DepName)
Write-Raw (Join-Path $ProfileDir 'package.json') ($t18Json | ConvertTo-Json -Depth 10)
New-Item -ItemType Junction -Path $linkedDir -Target $PluginBroken | Out-Null
$t18 = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T18 apply refuses a link that resolves elsewhere' ($t18.Code -ne 0) ("code=" + $t18.Code + " :: " + $t18.Text)
Check 'T18 the refusal names the foreign target' ($t18.Text -match 'does not resolve to this package') ("text=" + $t18.Text)
Check 'T18 the refusal points at rollback.bat' ($t18.Text -match 'rollback\.bat') ("text=" + $t18.Text)
$t18Target = ''
try { $t18Item = Get-Item -LiteralPath $linkedDir -Force; $t18Target = [string](@($t18Item.Target)[0]) } catch { }
Check 'T18 the link really pointed at the other package' ($t18Target -like '*plugin-broken*') ("target=" + $t18Target)

# Without a snapshot there is nothing to restore, so rollback must refuse rather
# than guess; the fixture is then put back by hand.
$t18b = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T18 rollback refuses when traces exist without a snapshot' ($t18b.Code -ne 0) ("code=" + $t18b.Code + " :: " + $t18b.Text)
Check 'T18 that refusal explains the missing snapshot' ($t18b.Text -match 'no snapshot') ("text=" + $t18b.Text)

& cmd.exe /c "rmdir `"$linkedDir`"" | Out-Null
Copy-Item -LiteralPath (Join-Path $OriginalDir 'package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
$t18c = Invoke-Step $ApplyScript @('-ProfileDir', $ProfileDir, '-PluginDir', $PluginFixture)
Check 'T18 a clean retry applies' ($t18c.Code -eq 0) ("code=" + $t18c.Code + " :: " + $t18c.Text)
$t18Target2 = ''
try { $t18Item2 = Get-Item -LiteralPath $linkedDir -Force; $t18Target2 = [string](@($t18Item2.Target)[0]) } catch { }
Check 'T18 the link now resolves to this package' ($t18Target2 -like '*\plugin') ("target=" + $t18Target2)
$t18d = Invoke-Step $RollbackScript @('-ProfileDir', $ProfileDir)
Check 'T18 the final rollback exits 0' ($t18d.Code -eq 0) ("code=" + $t18d.Code + " :: " + $t18d.Text)

# -------------------------------------------------------------------- T19 ---
# A brand-new profile carries "dependencies": {} -- an EMPTY property bag. Under
# Set-StrictMode -Version Latest, member enumeration on an empty bag
# (@($obj.PSObject.Properties.Name)) is a terminating PropertyNotFoundStrict
# error, so both scripts must read that shape some other way. The real profile on
# this machine has dependencies, which is why the suite missed this until the
# relocatable fixture started synthesizing an empty one.
$env:APPDATA = Join-Path $Root 'appdata'
$env:PATH = $SanitizedPath
$emptyDir = Join-Path $Root 'empty-profile'
if (Test-Path -LiteralPath $emptyDir) { Remove-Item -LiteralPath $emptyDir -Recurse -Force }
New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
foreach ($name in $ProfileFiles) { Copy-Item -LiteralPath (Join-Path $OriginalDir $name) -Destination (Join-Path $emptyDir $name) -Force }
$emptyJson = Read-Json (Join-Path $emptyDir 'package.json')
$emptyJson.dependencies = [pscustomobject]@{}
Write-Raw (Join-Path $emptyDir 'package.json') ($emptyJson | ConvertTo-Json -Depth 10)
$t19 = Invoke-Step $ApplyScript @('-ProfileDir', $emptyDir, '-PluginDir', $PluginFixture, '-DryRun')
Check 'T19 dry run tolerates an empty dependencies object' ($t19.Code -eq 0) ("code=" + $t19.Code + " :: " + $t19.Text)
Check 'T19 no strict-mode property error' (-not ($t19.Text -match 'cannot be found|PropertyNotFoundStrict')) ("text=" + $t19.Text)
Check 'T19 the dry run made no snapshot' (-not (Test-Path -LiteralPath (Join-Path $emptyDir '.dsh-ctm-snapshot')))
$t19b = Invoke-Step $RollbackScript @('-ProfileDir', $emptyDir)
Check 'T19 rollback tolerates an empty dependencies object' ($t19b.Code -eq 0) ("code=" + $t19b.Code + " :: " + $t19b.Text)
Check 'T19 rollback reports nothing to roll back' ($t19b.Text -match 'nothing to roll back') ("text=" + $t19b.Text)

# -------------------------------------------------------------------- T20 ---
# The shipped default has to work on somebody else's machine: no -ProfileDir at
# all, only a DSH_HOME. "desktop" wins when it exists; otherwise the single other
# profile is used. A default that hard-coded one machine's path would pass every
# other case in this file, because they all pass -ProfileDir explicitly.
$env:PATH = $SanitizedPath
$env:APPDATA = Join-Path $Root 'appdata'
$savedDshHome = $env:DSH_HOME
foreach ($case in @(
        @{ Name = 'desktop-preferred'; Directory = 'desktop' },
        @{ Name = 'single-other'; Directory = 'myprofile' }
    )) {
    $caseHome = Join-Path $Root ("home-" + $case.Name)
    if (Test-Path -LiteralPath $caseHome) { Remove-Item -LiteralPath $caseHome -Recurse -Force }
    $prof = Join-Path (Join-Path $caseHome 'profiles') $case.Directory
    New-Item -ItemType Directory -Path $prof -Force | Out-Null
    foreach ($name in $ProfileFiles) { Copy-Item -LiteralPath (Join-Path $OriginalDir $name) -Destination (Join-Path $prof $name) -Force }
    $env:DSH_HOME = $caseHome
    $t20 = Invoke-Step $ApplyScript @('-PluginDir', $PluginFixture, '-DryRun')
    Check ("T20 default profile resolution: " + $case.Name) ($t20.Code -eq 0 -and $t20.Text -match [regex]::Escape($prof)) ("code=" + $t20.Code + " :: " + $t20.Text)
    $t20b = Invoke-Step $RollbackScript @()
    Check ("T20 rollback resolves the same profile: " + $case.Name) ($t20b.Code -eq 0 -and $t20b.Text -match [regex]::Escape($prof)) ("code=" + $t20b.Code + " :: " + $t20b.Text)
    Check ("T20 no snapshot was written: " + $case.Name) (-not (Test-Path -LiteralPath (Join-Path $prof '.dsh-ctm-snapshot')))
}
if ($null -eq $savedDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $savedDshHome }

$env:APPDATA = Join-Path $Root 'appdata'
$env:PATH = $SanitizedPath
$finalHashes3 = Get-Hashes -Directory $ProfileDir
$identical3 = $true
foreach ($name in $originalHashes.Keys) { if ($originalHashes[$name] -ne $finalHashes3[$name]) { $identical3 = $false } }
Check 'T15/T16/T17/T18 profile is byte-identical to the original again' $identical3

# ---------------------------------------------------------------- summary ---
Write-Host ''
Write-Host ("passed: " + $script:Passed + "   failed: " + $script:Failed)
if ($script:Failed -gt 0) { exit 1 }
Write-Host 'all script self-tests passed' -ForegroundColor Green
exit 0
