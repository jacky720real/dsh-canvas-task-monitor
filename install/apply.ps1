<#
  apply.ps1 -- install the "Canvas Task Monitor" DSH plugin into the desktop profile.

  The plugin is fully self-contained and runs in-process: there is no Python
  sidecar, no bridge process, no virtualenv and no separate service to start.
  Everything (host half, client half, its own SQLite store and its own
  same-origin HTTP routes) lives in the repository it is linked from, and that
  repository root IS the plugin package: package.json, cordis.patch.yml,
  lib/index.js and lib/client.js.

  What it changes (nothing else):
    1. profile package.json -> adds dependency dsh-canvas-task-monitor (link:<pkgdir>)
                               and appends it to dsh.profile.bundles
    2. runs the profile's package manager once (dsh plugin add, falling back to pnpm add)

  It never touches cordis.patch.yml or cordis.yml: the loader entry for this
  plugin travels inside the package itself (its dsh.bundle.patch), which is the
  mechanism every other third-party bundle in this profile already uses, and
  DSH loads it for every active bundle. It never reorders existing bundles,
  never installs, removes or upgrades any other plugin, and never upgrades dsh
  itself.

  Idempotent:
    * the snapshot is created only when none exists (never overwritten)
    * if the profile already carries all three markers -> "nothing to do", exit 0
    * if the profile is only partially patched and no snapshot exists -> refuses (exit 1)

  Uses only ASCII output on purpose: Windows PowerShell 5.1 decodes BOM-less
  UTF-8 scripts as ANSI, so non-ASCII text here would come out as mojibake.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    # Only meant for the self-test harness, which points it at a throwaway copy
    # of the profile. The default is the real profile.
    [string]$ProfileDir = 'C:\Users\<you>\.dsh\profiles\desktop',
    # The repository root of the plugin - which is the plugin package itself.
    # This is the published location; the self-test overrides it with a
    # throwaway copy so it can link that instead.
    [string]$PluginDir = '<repo-root>'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DepName       = 'dsh-canvas-task-monitor'
# Derived from $PluginDir so an overridden -PluginDir is also the directory the
# package manager is told to link; with the default it is exactly
# link:<repo-root>.
$DepSpec       = 'link:' + $PluginDir.Replace('\', '/')
$LoaderId      = 'canvas-task-monitor'
$SnapshotDir   = Join-Path $ProfileDir '.dsh-ctm-snapshot'
$SnapshotFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')

# DSH Desktop applies this to every package-manager operation it starts
# (lib/pnpm-policy: "Desktop-wide pnpm policy"). Keeping the same flag here
# stops a foreign pnpm on PATH from failing the install on pnpm 12's default
# minimum-release-age gate, without rewriting any of the user's pnpm config.
$PnpmPolicyArg = '--config.minimumReleaseAge=0'

$PackageJson = Join-Path $ProfileDir 'package.json'
$PatchYml    = Join-Path $ProfileDir 'cordis.patch.yml'

$script:IsDryRun = $DryRun.IsPresent
$script:Nl = "`n"

# ---------------------------------------------------------------- output ----
function Say([string]$Text) { Write-Host "[apply] $Text" }
function SayWarn([string]$Text) { Write-Host "[apply] WARN  $Text" -ForegroundColor Yellow }
function SayOk([string]$Text) { Write-Host "[apply] OK    $Text" -ForegroundColor Green }
function Stop-Fail([string]$Text) {
    Write-Host "[apply] FAIL  $Text" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------- io -----
function Read-Text([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Text([string]$Path, [string]$Text) {
    # UTF-8 without BOM: pnpm/power-shell tooling cannot parse a BOM here.
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-PropertyNames($Object) {
    # StrictMode-safe replacement for @($Object.PSObject.Properties.Name):
    # member enumeration on a property bag with NO properties raises
    # PropertyNotFoundStrict, and that is exactly what "dependencies": {}
    # looks like in a profile that has not installed anything yet.
    $names = @()
    if ($null -eq $Object) { return $names }
    foreach ($property in $Object.PSObject.Properties) { $names += [string]$property.Name }
    return $names
}

function Get-LinkTarget([string]$Path) {
    # Resolved target of a reparse point (directory symlink or junction), or ''
    # when the path is a real directory (a hoisted copy) or unreadable.
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return '' }
    $raw = @($item.Target)[0]
    if ([string]::IsNullOrEmpty($raw)) { return '' }
    if (-not [System.IO.Path]::IsPathRooted($raw)) { $raw = Join-Path (Split-Path -Parent $Path) $raw }
    return [System.IO.Path]::GetFullPath($raw).TrimEnd('\')
}

function Test-LinkedIdentity([string]$LinkDir, [string]$ExpectedDir) {
    # $true when node_modules\<Dep> really is ExpectedDir: the link target must
    # match when it resolves, and the manifest name/version must match either way
    # (a hoisted copy is not a reparse point, so the manifest is the only tell).
    $expected = [System.IO.Path]::GetFullPath($ExpectedDir).TrimEnd('\')
    $target = Get-LinkTarget $LinkDir
    if ($target -ne '' -and $target -ne $expected) { return $false }
    $linkedManifest = Join-Path $LinkDir 'package.json'
    if (-not (Test-Path -LiteralPath $linkedManifest)) { return $false }
    $expectedManifest = Join-Path $expected 'package.json'
    if (-not (Test-Path -LiteralPath $expectedManifest)) { return $false }
    $linked = Read-Text $linkedManifest | ConvertFrom-Json
    $want = Read-Text $expectedManifest | ConvertFrom-Json
    if ((Get-Prop $linked 'name') -ne (Get-Prop $want 'name')) { return $false }
    if ((Get-Prop $linked 'version') -ne (Get-Prop $want 'version')) { return $false }
    return $true
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
        # Windows PowerShell 5.1 turns a native command's stderr into a
        # terminating NativeCommandError while ErrorActionPreference is Stop,
        # which would abort before the pnpm fallback could ever run. Judge
        # success by $LASTEXITCODE instead.
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "        $_" }
        return $LASTEXITCODE
    }
    finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $saved
    }
}

# -------------------------------------------------------------- discovery ---
function Find-DshCommand {
    # PATH wins: a shim found by recursing into host-commands is a generation
    # directory that may belong to a different profile.
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
    # The finders above return either a CommandInfo (Source/Path) or a FileInfo
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
    # DSH Desktop ships its own pnpm shim, and that shim is the only place
    # that owns the Desktop-wide policy argument. Preferring it also keeps the
    # profile on the exact pnpm version its .modules.yaml records (a newer,
    # unrelated pnpm from PATH would rewrite the lockfile in its own format).
    $root = Join-Path $env:APPDATA 'DSH Desktop\runtime-commands\generations'
    if (-not (Test-Path -LiteralPath $root)) { return $null }
    $hits = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'pnpm.cmd' -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending)
    if ($hits.Count -gt 0) { return $hits[0] }
    return $null
}

# -------------------------------------------------------------- preflight ---
Say "profile : $ProfileDir"
Say "plugin  : $PluginDir"
Say "spec    : $DepSpec"
if ($script:IsDryRun) { Say "mode    : DRY RUN (nothing will be written)" }

if (-not (Test-Path -LiteralPath $ProfileDir))  { Stop-Fail "profile directory not found: $ProfileDir" }
if (-not (Test-Path -LiteralPath $PackageJson)) { Stop-Fail "profile package.json not found: $PackageJson" }
if (-not (Test-Path -LiteralPath $PluginDir))   { Stop-Fail "plugin package directory not found: $PluginDir" }

foreach ($relative in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')) {
    $path = Join-Path $PluginDir $relative
    if (-not (Test-Path -LiteralPath $path)) { Stop-Fail "plugin file missing: $path" }
}

$packageText = Read-Text $PackageJson
try { $package = $packageText | ConvertFrom-Json } catch { Stop-Fail "profile package.json is not valid JSON: $($_.Exception.Message)" }

$bundles = Get-Prop (Get-Prop (Get-Prop $package 'dsh') 'profile') 'bundles'
if ($null -eq $bundles -or $bundles -isnot [System.Array]) {
    Stop-Fail "dsh.profile.bundles is missing or not an array -- refusing to guess"
}
$dependencies = Get-Prop $package 'dependencies'
$dependencyNames = @()
if ($null -ne $dependencies) { $dependencyNames = @(Get-PropertyNames $dependencies) }

$patchText = ''
$patchExisted = Test-Path -LiteralPath $PatchYml
if ($patchExisted) { $patchText = Read-Text $PatchYml }

$alreadyInBundles = @($bundles) -contains $DepName
$alreadyDependency = $dependencyNames -contains $DepName
$alreadyLinked = Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$DepName")
$hasSnapshot = Test-Path -LiteralPath $SnapshotDir
# A hand-written copy of this plugin's loader entry in the profile patch would
# be a duplicate: the entry ships inside the package (its dsh.bundle.patch).
$strayPatchEntry = [regex]::IsMatch($patchText, "(?m)^\s*-\s*id:\s*$([regex]::Escape($LoaderId))\s*$")

Say "state   : bundles=$alreadyInBundles dependency=$alreadyDependency linked=$alreadyLinked snapshot=$hasSnapshot"

if ($strayPatchEntry) {
    Stop-Fail ("$PatchYml already carries a loader entry for '$LoaderId'. This plugin ships that " +
               "entry inside its own package, so the copy in the profile patch would duplicate it " +
               "(two loader rows with the same id). Remove that entry first.")
}
if ($hasSnapshot) {
    Stop-Fail ("a snapshot already exists at $SnapshotDir -- this profile was already patched by apply. " +
               "Run rollback.bat first, or delete that directory if you are certain you want a fresh apply.")
}
if ($alreadyInBundles -and $alreadyDependency -and $alreadyLinked) {
    # All three traces are present -- but the link can still point at another
    # package: the previous version of this plugin was pinned at a different
    # directory, and pnpm does not repoint an existing link. Never report
    # success (and never let DSH load the old code) without checking identity.
    if (-not (Test-LinkedIdentity (Join-Path $ProfileDir "node_modules\$DepName") $PluginDir)) {
        $actual = Get-LinkTarget (Join-Path $ProfileDir "node_modules\$DepName")
        if ($actual -eq '') { $actual = 'a different directory' }
        Stop-Fail ("node_modules\$DepName exists but does not resolve to this package (it points at $actual). " +
                   "Run rollback.bat -- it removes that entry -- and then apply.bat again.")
    }
    SayOk "nothing to do -- the plugin is already present in this profile"
    exit 0
}
if ($alreadyInBundles -or $alreadyDependency -or $alreadyLinked) {
    Stop-Fail ("the profile is only partially patched and no snapshot exists " +
               "(bundles=$alreadyInBundles dependency=$alreadyDependency linked=$alreadyLinked). " +
               "Refusing to guess: clean those traces up by hand first, or restore a known-good package.json.")
}

# --------------------------------------------------- resolve install tool ---
# The dsh channel is only used when the shim's own default profile is the one
# this script is about to edit, and dsh is then told to target that same name.
# Turning this into an explicit --profile keeps an overridden -ProfileDir (the
# self-test) from ever pointing dsh at a different profile than the files it
# rewrites.
$ProfileName = Split-Path -Leaf $ProfileDir
$dshCommand = Find-DshCommand
$useDsh = $false
if ($null -ne $dshCommand) {
    $shimPath = Get-CommandPath $dshCommand
    if (-not $shimPath) {
        SayWarn 'found a dsh entry but could not resolve its path; falling back to pnpm'
    }
    else {
        $shimProfile = Get-DshShimDefaultProfile $shimPath
        if ($shimProfile -ne $ProfileName) {
            SayWarn "ignoring dsh shim at ${shimPath}: it defaults to profile '$shimProfile', not '$ProfileName'"
        }
        else {
            $useDsh = $true
            Say "channel : dsh plugin add ($shimPath)"
        }
    }
}
# pnpm is resolved unconditionally: it is also the fallback when the dsh
# channel fails, and leaving $pnpmPath unset would bind an empty -FilePath.
#
# The Desktop runtime shim wins over whatever PATH happens to offer. Two
# reasons: `dsh plugin` forwards to `pnpm` resolved *from PATH*
# (dsh/lib/plugin-*.js spawnSync("pnpm")), so the shim's directory has to be
# first for that channel to get the Desktop policy at all; and the shim is the
# pnpm version the profile's .modules.yaml records.
$pnpmPath = $null
$runtimePnpm = Find-DshRuntimePnpm
if ($null -ne $runtimePnpm) {
    $pnpmPath = Get-CommandPath $runtimePnpm
    if ($pnpmPath) {
        $runtimeBin = Split-Path -Parent $pnpmPath
        $env:PATH = $runtimeBin + ';' + $env:PATH
        Say "pnpm    : $pnpmPath (Desktop runtime shim; owns the Desktop pnpm policy)"
    }
}
if (-not $pnpmPath) {
    $pnpmCommand = Find-PnpmCommand
    if ($null -ne $pnpmCommand) { $pnpmPath = Get-CommandPath $pnpmCommand }
    if ($pnpmPath) { Say "pnpm    : $pnpmPath (no Desktop runtime shim found; the policy flag is passed explicitly)" }
}
if (-not $useDsh) {
    if (-not $pnpmPath) { Stop-Fail "neither a usable dsh shim nor pnpm was found on PATH" }
    Say "channel : pnpm add ($pnpmPath)"
}

# ------------------------------------------------------------- planned work -
$bundlesPattern = '"bundles"\s*:\s*\[(?<body>[^\]]*)\]'
$bundlesMatch = [regex]::Match($packageText, $bundlesPattern)
if (-not $bundlesMatch.Success) { Stop-Fail "could not locate the dsh.profile.bundles array in package.json" }

$newline = "`n"
if ($packageText.Contains("`r`n")) { $newline = "`r`n" }

Say "plan    : 1) install dependency $DepName"
Say ('plan    : 2) append "' + $DepName + '" to dsh.profile.bundles (skipped if the dsh channel reconciles it)')
Say "plan    : 3) leave cordis.patch.yml untouched -- the loader entry ships inside the package"

if ($script:IsDryRun) {
    Say "dry run complete -- no files were written, no package manager was invoked"
    exit 0
}

# ---------------------------------------------------------------- snapshot --
New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null
foreach ($name in $SnapshotFiles) {
    $source = Join-Path $ProfileDir $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $SnapshotDir $name) -Force
    }
}
$manifest = [ordered]@{
    createdAtUtc    = (Get-Date).ToUniversalTime().ToString('o')
    plugin          = $DepName
    dependencyValue = $DepSpec
    loaderId        = $LoaderId
    profileDir      = $ProfileDir
    pluginDir       = $PluginDir
    files           = @($SnapshotFiles | Where-Object { Test-Path -LiteralPath (Join-Path $SnapshotDir $_) })
}
Write-Text (Join-Path $SnapshotDir 'snapshot.json') ($manifest | ConvertTo-Json -Depth 5)
SayOk "snapshot written to $SnapshotDir"

# --------------------------------------------------------------- 1) install -
$installExit = -1
if ($useDsh) {
    Write-Host "[apply] running: dsh plugin --profile $ProfileName add $DepSpec"
    # No policy flag here on purpose: dsh's own desktop-cli strips a forwarded
    # copy (lib/pnpm-policy withoutForwardedDesktopPnpmPolicy) because the
    # runtime shim on PATH is supposed to own it -- which is why the shim's
    # directory was placed first on PATH above.
    $installExit = Invoke-Native -FilePath $shimPath -Arguments @('plugin', '--profile', $ProfileName, 'add', $DepSpec)
    if ($installExit -ne 0) { SayWarn "dsh plugin add exited with $installExit -- falling back to pnpm" }
}
if (-not $useDsh -or $installExit -ne 0) {
    if (-not $pnpmPath) {
        Stop-Fail "the dsh channel failed and pnpm was not found on PATH. The snapshot was kept -- run rollback.bat"
    }
    Write-Host "[apply] running: pnpm $PnpmPolicyArg add $DepSpec   (cwd: $ProfileDir)"
    $installExit = Invoke-Native -FilePath $pnpmPath -Arguments @($PnpmPolicyArg, 'add', $DepSpec) -WorkDir $ProfileDir
}
if ($installExit -ne 0) {
    Stop-Fail ("the package manager failed with exit code $installExit. " +
               "The snapshot was kept -- run rollback.bat to return to the previous state.")
}

$reloaded = Read-Text $PackageJson | ConvertFrom-Json
$reloadedDependencies = Get-Prop $reloaded 'dependencies'
if ($null -eq $reloadedDependencies -or -not (@(Get-PropertyNames $reloadedDependencies) -contains $DepName)) {
    Stop-Fail "the package manager did not record the $DepName dependency; the snapshot was kept -- run rollback.bat"
}
SayOk "dependency recorded: $DepName = $(Get-Prop $reloadedDependencies $DepName)"

# --------------------------------------------------------------- 2) bundles -
$currentPackageText = Read-Text $PackageJson
$currentMatch = [regex]::Match($currentPackageText, $bundlesPattern)
if (-not $currentMatch.Success) { Stop-Fail "dsh.profile.bundles disappeared from package.json; the snapshot was kept -- run rollback.bat" }
$bundlesAlreadyListed = [regex]::IsMatch($currentMatch.Groups['body'].Value, '"' + [regex]::Escape($DepName) + '"')
if ($bundlesAlreadyListed) {
    # `dsh plugin` reconciles dsh.profile.bundles itself: a newly installed
    # dependency that declares dsh.bundle joins the layer list (dsh's
    # lib/plugin-*.js reconcilePlugins). Appending it again would duplicate it.
    SayOk "dsh.profile.bundles already lists $DepName (reconciled by the dsh channel)"
}
else {
    $currentBody = $currentMatch.Groups['body'].Value.TrimEnd()
    if ($currentBody.Length -gt 0 -and -not $currentBody.EndsWith(',')) { $currentBody += ',' }
    $currentBody += $newline + '        "' + $DepName + '"' + $newline + '      '
    $updatedPackageText = $currentPackageText.Remove($currentMatch.Index, $currentMatch.Length).Insert($currentMatch.Index, '"bundles": [' + $currentBody + ']')

    try {
        $check = $updatedPackageText | ConvertFrom-Json
    }
    catch {
        Stop-Fail "the edited package.json would not parse; the snapshot was kept -- run rollback.bat"
    }
    if (-not (@(Get-Prop (Get-Prop (Get-Prop $check 'dsh') 'profile') 'bundles') -contains $DepName)) {
        Stop-Fail "the bundles edit did not take effect in memory; the snapshot was kept -- run rollback.bat"
    }
    Write-Text $PackageJson $updatedPackageText
    SayOk "dsh.profile.bundles now lists $DepName (appended last; official bundles untouched)"
}

# ------------------------------------------------------- 3) patch untouched -
# DSH reads the loader entry from the package itself: for every name listed in
# dsh.profile.bundles it resolves the package, requires the dsh.bundle.patch
# declaration (profile-*.js throws "declares no dsh.bundle in its
# package.json" otherwise) and loads that file as a patch layer. The
# profile-level cordis.patch.yml is a separate layer loaded after the bundle
# layers, so a copy of the entry there would register the same id twice.
if ($patchExisted) {
    if ((Read-Text $PatchYml) -ne $patchText) {
        Stop-Fail "cordis.patch.yml changed unexpectedly; the snapshot was kept -- run rollback.bat"
    }
}
SayOk "cordis.patch.yml left byte-identical (the loader entry ships inside the package)"

# --------------------------------------------------------------- verify -----
$finalPackage = Read-Text $PackageJson | ConvertFrom-Json
$finalBundles = @(Get-Prop (Get-Prop (Get-Prop $finalPackage 'dsh') 'profile') 'bundles')
if (-not ($finalBundles -contains $DepName)) { Stop-Fail "verification failed: $DepName is not in dsh.profile.bundles" }
if (@($finalBundles).Count -ne @($bundles).Count + 1) {
    SayWarn "bundle count went from $(@($bundles).Count) to $(@($finalBundles).Count) -- expected exactly one new entry"
}
$officialBase = @($finalBundles)[0]
if ($officialBase -ne '@deepseek-ai/dsh-base') { Stop-Fail "verification failed: the first bundle is no longer @deepseek-ai/dsh-base" }

$linkedDir = Join-Path $ProfileDir "node_modules\$DepName"
if (-not (Test-Path -LiteralPath $linkedDir)) { Stop-Fail "verification failed: $linkedDir does not exist" }

function Get-LinkTarget([string]$Path) {
    # Returns the resolved target of a reparse point, or '' when the path is a
    # real directory (a hoisted copy) or the target cannot be read.
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return '' }
    $raw = @($item.Target)[0]
    if ([string]::IsNullOrEmpty($raw)) { return '' }
    if (-not [System.IO.Path]::IsPathRooted($raw)) { $raw = Join-Path (Split-Path -Parent $Path) $raw }
    return [System.IO.Path]::GetFullPath($raw).TrimEnd('\')
}

# The entry has to be THIS package. A previous installation of the same name
# pinned node_modules\<DepName> somewhere else (that is exactly what the old
# Python-plugin package did), and pnpm does not always repoint an existing link,
# so comparing manifests alone is not enough -- resolve the link target too and
# repair once instead of silently loading stale code.
$expectedTarget = [System.IO.Path]::GetFullPath($PluginDir).TrimEnd('\')
$manifestPath = Join-Path $linkedDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-Fail "verification failed: $manifestPath does not exist" }
$linkedManifest = Read-Text $manifestPath | ConvertFrom-Json
$expectedManifest = Read-Text (Join-Path $PluginDir 'package.json') | ConvertFrom-Json
$linkedTarget = Get-LinkTarget $linkedDir
$identityMismatch = ($linkedTarget -ne '' -and $linkedTarget -ne $expectedTarget) -or
    ((Get-Prop $linkedManifest 'name') -ne (Get-Prop $expectedManifest 'name')) -or
    ((Get-Prop $linkedManifest 'version') -ne (Get-Prop $expectedManifest 'version'))
if ($identityMismatch) {
    $where = if ($linkedTarget -eq '') { 'a real directory' } else { $linkedTarget }
    SayWarn ("node_modules\$DepName does not resolve to this package (it points at $where) -- repairing")
    if ($linkedTarget -eq '') { Remove-Item -LiteralPath $linkedDir -Recurse -Force }
    else { & cmd.exe /c "rmdir `"$linkedDir`"" | Out-Null }
    if (Test-Path -LiteralPath $linkedDir) { Stop-Fail "verification failed: $linkedDir could not be removed for repair" }
    $repairExit = -1
    if ($useDsh) { $repairExit = Invoke-Native -FilePath $shimPath -Arguments @('plugin', '--profile', $ProfileName, 'install') }
    if (-not $useDsh -or $repairExit -ne 0) {
        if (-not $pnpmPath) {
            Stop-Fail "the link could not be repaired and pnpm was not found on PATH; the snapshot was kept -- run rollback.bat"
        }
        $repairExit = Invoke-Native -FilePath $pnpmPath -Arguments @($PnpmPolicyArg, 'install') -WorkDir $ProfileDir
    }
    if ($repairExit -ne 0) { Stop-Fail "repairing node_modules\$DepName failed (exit $repairExit); the snapshot was kept -- run rollback.bat" }
    if (-not (Test-Path -LiteralPath $linkedDir)) { Stop-Fail "verification failed: $linkedDir was not recreated by the repair run" }
    $manifestPath = Join-Path $linkedDir 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-Fail "verification failed: $manifestPath does not exist after the repair run" }
    $linkedManifest = Read-Text $manifestPath | ConvertFrom-Json
    $linkedTarget = Get-LinkTarget $linkedDir
    if ($linkedTarget -ne '' -and $linkedTarget -ne $expectedTarget) {
        Stop-Fail "verification failed: $linkedDir still points at $linkedTarget instead of $expectedTarget"
    }
    if (((Get-Prop $linkedManifest 'name') -ne (Get-Prop $expectedManifest 'name')) -or
        ((Get-Prop $linkedManifest 'version') -ne (Get-Prop $expectedManifest 'version'))) {
        Stop-Fail "verification failed: $linkedDir still contains another package after the repair run"
    }
    SayOk "repaired the link: node_modules\$DepName now resolves to this package"
}
if ($linkedTarget -ne '') { SayOk "linked package resolves to $linkedTarget" }
else { SayOk "linked package is a hoisted copy of this package" }
$declaredPatch = Get-Prop (Get-Prop (Get-Prop $linkedManifest 'dsh') 'bundle') 'patch'
if ([string]::IsNullOrEmpty($declaredPatch)) { Stop-Fail "verification failed: the linked package declares no dsh.bundle.patch" }
if (-not (Test-Path -LiteralPath (Join-Path $linkedDir $declaredPatch))) {
    Stop-Fail "verification failed: dsh.bundle.patch ($declaredPatch) does not exist inside the linked package"
}
SayOk "linked package declares patch $declaredPatch"

Write-Host ''
SayOk "apply finished"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH Desktop so the new bundle and its client half are loaded.'
Write-Host '  2. A "Tasks" row should appear in the left sidebar, with a badge button at its foot.'
Write-Host '  3. If anything looks wrong, run rollback.bat from an external terminal.'
