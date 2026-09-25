<#
  rollback.ps1 -- undo exactly what apply.ps1 did to the desktop profile.

  It undoes the install of the self-contained dsh-canvas-task-monitor bundle.
  That plugin has no Python sidecar and no bridge process: the host half runs
  in-process, so rolling back is purely a profile/package-manager operation.

  It restores package.json, pnpm-lock.yaml, pnpm-workspace.yaml and
  cordis.patch.yml from the snapshot taken by apply.ps1, runs the profile's
  package manager once so node_modules matches the restored lockfile, verifies
  that every trace of the plugin is gone, and only then removes the snapshot.

  Idempotent: running it twice is safe. The second run finds no snapshot and a
  clean profile and simply reports "nothing to roll back".

  If apply.ps1 failed halfway, the snapshot is still there and this script
  brings the profile back to its pre-apply state.

  Uses only ASCII output on purpose: Windows PowerShell 5.1 decodes BOM-less
  UTF-8 scripts as ANSI, so non-ASCII text here would come out as mojibake.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    # Only meant for the self-test harness, which points it at a throwaway copy
    # of the profile. The default is the real profile.
    [string]$ProfileDir = 'C:\Users\<you>\.dsh\profiles\desktop'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DepName       = 'dsh-canvas-task-monitor'
$LoaderId      = 'canvas-task-monitor'
$SnapshotDir   = Join-Path $ProfileDir '.dsh-ctm-snapshot'
$SnapshotFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')

# Same Desktop-wide policy argument apply.ps1 uses (see the comment there).
$PnpmPolicyArg = '--config.minimumReleaseAge=0'

$PackageJson = Join-Path $ProfileDir 'package.json'
$PatchYml    = Join-Path $ProfileDir 'cordis.patch.yml'

$script:IsDryRun = $DryRun.IsPresent

function Say([string]$Text) { Write-Host "[rollback] $Text" }
function SayWarn([string]$Text) { Write-Host "[rollback] WARN  $Text" -ForegroundColor Yellow }
function SayOk([string]$Text) { Write-Host "[rollback] OK    $Text" -ForegroundColor Green }
function Stop-Fail([string]$Text) {
    Write-Host "[rollback] FAIL  $Text" -ForegroundColor Red
    exit 1
}

function Read-Text([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Text([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkDir = ''
    )
    $saved = $ErrorActionPreference
    $pushed = $false
    if ($WorkDir -ne '') {
        if (-not (Test-Path -LiteralPath $WorkDir)) { Stop-Fail "working directory not found: $WorkDir" }
        Push-Location -LiteralPath $WorkDir
        $pushed = $true
    }
    try {
        # See apply.ps1: native stderr must not become a terminating error.
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "        $_" }
        return $LASTEXITCODE
    }
    finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $saved
    }
}

function Find-DshCommand {
    # @() everywhere: under Set-StrictMode a single match is a scalar and has no
    # .Count property at all.
    $onPath = @(Get-Command -Name 'dsh' -CommandType Application -ErrorAction SilentlyContinue)
    if ($onPath.Count -gt 0) { return $onPath[0] }
    $root = Join-Path $env:APPDATA 'DSH Desktop\host-commands'
    if (Test-Path -LiteralPath $root) {
        $hits = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'dsh.cmd' -ErrorAction SilentlyContinue |
            Sort-Object -Property FullName)
        if ($hits.Count -gt 0) { return $hits[0] }
    }
    return $null
}

function Get-CommandPath($Command) {
    # The finders return either a CommandInfo (Source/Path) or a FileInfo
    # (FullName only, no Source at all). Under Set-StrictMode reading a missing
    # property is a terminating error, so each candidate name is probed through
    # PSObject.Properties instead of being dereferenced directly.
    foreach ($name in @('Source', 'Path', 'FullName')) {
        $property = $Command.PSObject.Properties[$name]
        if ($null -ne $property -and $property.Value) { return [string]$property.Value }
    }
    return $null
}

function Get-DshShimDefaultProfile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    $found = [regex]::Matches($text, 'DSH_DESKTOP_DEFAULT_PROFILE=([A-Za-z0-9._-]+)')
    if ($found.Count -eq 0) { return $null }
    return $found[$found.Count - 1].Groups[1].Value
}

function Find-PnpmCommand {
    foreach ($name in @('pnpm.cmd', 'pnpm.exe', 'pnpm')) {
        $found = @(Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue)
        if ($found.Count -gt 0) { return $found[0] }
    }
    $candidates = @(
        (Join-Path $env:APPDATA 'npm\pnpm.cmd'),
        (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe'),
        (Join-Path $env:LOCALAPPDATA 'hermes\bin\pnpm.cmd'),
        (Join-Path $env:ProgramFiles 'nodejs\pnpm.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Get-Item -LiteralPath $candidate)
        }
    }
    return $null
}

function Find-DshRuntimePnpm {
    # DSH Desktop's own pnpm shim, the only place that owns the Desktop-wide
    # policy argument. See the matching comment in apply.ps1.
    $root = Join-Path $env:APPDATA 'DSH Desktop\runtime-commands\generations'
    if (-not (Test-Path -LiteralPath $root)) { return $null }
    $hits = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'pnpm.cmd' -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending)
    if ($hits.Count -gt 0) { return $hits[0] }
    return $null
}

# -------------------------------------------------------------- preflight ---
Say "profile : $ProfileDir"
if ($script:IsDryRun) { Say "mode    : DRY RUN (nothing will be written)" }
if (-not (Test-Path -LiteralPath $ProfileDir))  { Stop-Fail "profile directory not found: $ProfileDir" }
if (-not (Test-Path -LiteralPath $PackageJson)) { Stop-Fail "profile package.json not found: $PackageJson" }

$packageText = Read-Text $PackageJson
try { $package = $packageText | ConvertFrom-Json } catch { Stop-Fail "profile package.json is not valid JSON: $($_.Exception.Message)" }

$bundles = Get-Prop (Get-Prop (Get-Prop $package 'dsh') 'profile') 'bundles'
$dependencies = Get-Prop $package 'dependencies'
$dependencyNames = @()
if ($null -ne $dependencies) { $dependencyNames = @($dependencies.PSObject.Properties.Name) }
$patchText = ''
if (Test-Path -LiteralPath $PatchYml) { $patchText = Read-Text $PatchYml }

$hasDependency = $dependencyNames -contains $DepName
$hasBundleEntry = if ($null -ne $bundles) { @($bundles) -contains $DepName } else { $false }
$hasPatchEntry = [regex]::IsMatch($patchText, "(?m)^\s*-\s*id:\s*$([regex]::Escape($LoaderId))\s*$")
$hasSnapshot = Test-Path -LiteralPath $SnapshotDir

Say "state   : bundles=$hasBundleEntry dependency=$hasDependency patchEntry=$hasPatchEntry snapshot=$hasSnapshot"

if (-not $hasSnapshot) {
    if (-not $hasBundleEntry -and -not $hasDependency -and -not $hasPatchEntry) {
        SayOk "nothing to roll back -- the profile is already clean and no snapshot exists"
        exit 0
    }
    Stop-Fail ("no snapshot at $SnapshotDir, but the profile still carries traces " +
               "(bundles=$hasBundleEntry dependency=$hasDependency patchEntry=$hasPatchEntry). " +
               "Refusing to guess: remove those by hand, or restore a known-good package.json.")
}

# ------------------------------------------------------------ plan & apply --
$restorable = @()
foreach ($name in $SnapshotFiles) {
    $backup = Join-Path $SnapshotDir $name
    if (Test-Path -LiteralPath $backup) { $restorable += $name }
}
if ($restorable -notcontains 'package.json') {
    Stop-Fail "the snapshot does not contain package.json -- cannot restore safely"
}
Say "restore : $($restorable -join ', ')"

# The dsh channel is only used when the shim's own default profile is the one
# this script is about to restore, and dsh is then told to target that same
# name (see the matching comment in apply.ps1).
$ProfileName = Split-Path -Leaf $ProfileDir
$dshCommand = Find-DshCommand
$shimPath = ''
$useDsh = $false
if ($null -ne $dshCommand) {
    $shimPath = Get-CommandPath $dshCommand
    if (-not $shimPath) {
        SayWarn 'found a dsh entry but could not resolve its path; falling back to pnpm'
    }
    else {
        $shimProfile = Get-DshShimDefaultProfile $shimPath
        if ($shimProfile -ne $ProfileName) {
            SayWarn "skipping the dsh shim at ${shimPath}: it defaults to profile '$shimProfile', not '$ProfileName'"
        }
        else {
            $useDsh = $true
            Say "channel : dsh plugin install ($shimPath)"
        }
    }
}
# pnpm is resolved unconditionally: it is also the fallback when the dsh
# channel fails, and leaving $pnpmPath empty would bind an empty -FilePath.
# The Desktop runtime shim wins over PATH -- `dsh plugin` forwards to the
# `pnpm` it finds on PATH (dsh/lib/plugin-*.js spawnSync("pnpm")), so putting
# the shim's directory first is what gives that channel the Desktop policy.
$pnpmPath = ''
$runtimePnpm = Find-DshRuntimePnpm
if ($null -ne $runtimePnpm) {
    $pnpmPath = Get-CommandPath $runtimePnpm
    if ($pnpmPath) {
        $env:PATH = (Split-Path -Parent $pnpmPath) + ';' + $env:PATH
        Say "pnpm    : $pnpmPath (Desktop runtime shim)"
    }
}
if (-not $pnpmPath) {
    $pnpmCommand = Find-PnpmCommand
    if ($null -ne $pnpmCommand) { $pnpmPath = Get-CommandPath $pnpmCommand }
    if ($pnpmPath) { Say "pnpm    : $pnpmPath (no Desktop runtime shim found; the policy flag is passed explicitly)" }
}
if (-not $useDsh) {
    if (-not $pnpmPath) { Stop-Fail "neither a usable dsh shim nor pnpm was found on PATH" }
    Say "channel : pnpm install ($pnpmPath)"
}

if ($script:IsDryRun) {
    Say "dry run complete -- no files were written, no package manager was invoked"
    exit 0
}

# Copy every snapshot file back, even if it currently equals the backup:
# restoring is idempotent and this way a half-written profile is repaired.
foreach ($name in $restorable) {
    $backup = Join-Path $SnapshotDir $name
    $target = Join-Path $ProfileDir $name
    Copy-Item -LiteralPath $backup -Destination $target -Force
    SayOk "restored $name"
}

$restored = Read-Text $PackageJson | ConvertFrom-Json
$restoredBundles = Get-Prop (Get-Prop (Get-Prop $restored 'dsh') 'profile') 'bundles'
if ($null -ne $restoredBundles -and (@($restoredBundles) -contains $DepName)) {
    Stop-Fail "the snapshot still lists $DepName in dsh.profile.bundles -- the snapshot is not a pre-apply state. Nothing was pruned."
}
$restoredPatch = Read-Text $PatchYml
if ([regex]::IsMatch($restoredPatch, "(?m)^\s*-\s*id:\s*$([regex]::Escape($LoaderId))\s*$")) {
    Stop-Fail "the snapshot still contains the $LoaderId patch entry -- the snapshot is not a pre-apply state. Nothing was pruned."
}
SayOk "restored files are a pre-apply state"

# --------------------------------------------------------------- prune ------
$installExit = -1
if ($useDsh) {
    Write-Host "[rollback] running: dsh plugin --profile $ProfileName install"
    $installExit = Invoke-Native -FilePath $shimPath -Arguments @('plugin', '--profile', $ProfileName, 'install')
    if ($installExit -ne 0) { SayWarn "dsh plugin install exited with $installExit -- falling back to pnpm" }
}
if (-not $useDsh -or $installExit -ne 0) {
    if (-not $pnpmPath) {
        Stop-Fail "the dsh channel failed and pnpm was not found on PATH; the profile files were already restored from the snapshot, so pruning has to be done by hand"
    }
    Write-Host "[rollback] running: pnpm $PnpmPolicyArg install   (cwd: $ProfileDir)"
    $installExit = Invoke-Native -FilePath $pnpmPath -Arguments @($PnpmPolicyArg, 'install') -WorkDir $ProfileDir
}
if ($installExit -ne 0) {
    Stop-Fail ("the package manager failed with exit code $installExit. The profile files are already restored, " +
               "but node_modules may still contain $DepName. Fix the package manager and run rollback.bat again.")
}

# --------------------------------------------------------------- verify -----
$finalPackage = Read-Text $PackageJson | ConvertFrom-Json
$finalDependencies = Get-Prop $finalPackage 'dependencies'
$finalDependencyNames = @()
if ($null -ne $finalDependencies) { $finalDependencyNames = @($finalDependencies.PSObject.Properties.Name) }
if ($finalDependencyNames -contains $DepName) { Stop-Fail "verification failed: $DepName is still a dependency" }
$finalBundles = @(Get-Prop (Get-Prop (Get-Prop $finalPackage 'dsh') 'profile') 'bundles')
if ($finalBundles -contains $DepName) { Stop-Fail "verification failed: $DepName is still in dsh.profile.bundles" }
$finalPatch = Read-Text $PatchYml
if ([regex]::IsMatch($finalPatch, "(?m)^\s*-\s*id:\s*$([regex]::Escape($LoaderId))\s*$")) {
    Stop-Fail "verification failed: the $LoaderId patch entry is still present"
}
$linkedDir = Join-Path $ProfileDir "node_modules\$DepName"
if (Test-Path -LiteralPath $linkedDir) {
    Stop-Fail "verification failed: $linkedDir still exists after the package manager run"
}
SayOk "verified: no dependency, no bundle entry, no patch entry, no node_modules link"

Remove-Item -LiteralPath $SnapshotDir -Recurse -Force
SayOk "snapshot removed -- apply.bat can be run again if needed"

Write-Host ''
SayOk "rollback finished"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH Desktop so the plugin is unloaded.'
