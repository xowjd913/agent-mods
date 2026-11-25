# Herdr 모드를 설치·갱신한다(Windows). 다시 실행해도 된다. install.sh의 Windows 버전이다.
#   기본 모드: tabs-mine, work, prs, wt-menu, schedules
#   추가 모드(-Extras): usage-status, agent-groups, leader-tabs, path-menu, inbox
#   인자 없이 실행하면 설치된 모드만 갱신한다(처음이면 기본 모드를 설치한다).
#   -Only work,prs / -Add usage-status / -Remove leader-tabs / -List 로 모드를 고를 수 있다.
# 저장소를 받지 않고 바로 실행할 수도 있다.
#   & ([scriptblock]::Create((irm <저장소 raw 주소>/main/herdr/install.ps1)))
#   & ([scriptblock]::Create((irm <저장소 raw 주소>/main/herdr/install.ps1))) -Extras
# Herdr 설정 폴더는 HERDR_APP_HOME, 없으면 ~\.config\herdr-app 이다(Windows 경로는 실기 미확인: 다르면 HERDR_APP_HOME을 지정한다).
# Herdr가 없거나 실행 중이 아니거나 레이아웃 단계가 실패해도 안내만 출력하고 끝난다.
# irm으로 실행해도 창이 닫히지 않도록 exit 대신 return을 쓴다.
param([switch]$Extras, [string[]]$Only, [string[]]$Add, [string[]]$Remove, [switch]$List)
$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/xowjd913/agent-mods'
$Branch = 'main'
$AppHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }

# 고르는 옵션은 하나만 받는다.
$Picked = @(@{ n = '-Extras'; v = $Extras.IsPresent }, @{ n = '-Only'; v = [bool]$Only }, @{ n = '-Add'; v = [bool]$Add }, @{ n = '-Remove'; v = [bool]$Remove }, @{ n = '-List'; v = $List.IsPresent }) | Where-Object { $_.v }
if (@($Picked).Count -gt 1) {
  Write-Host "$((@($Picked) | ForEach-Object { $_.n }) -join ', ') 은(는) 함께 쓸 수 없습니다. 하나만 주세요."
  return
}

if (-not (Test-Path $AppHome -PathType Container) -and -not $List) {
  Write-Host "Herdr 설정 폴더($AppHome)가 없어 건너뜁니다. Herdr 앱을 한 번 실행한 뒤 다시 실행하세요."
  return
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'node가 없어 설치하지 못했습니다. Node.js를 설치한 뒤 다시 실행하세요(Work·PRs 패널도 node가 필요합니다).'
  return
}

# 저장소 안에서 실행했으면 그 파일을 쓰고, 아니면(irm) 압축 파일을 받아 임시 폴더에 푼다.
$Dir = $PSScriptRoot
$Tmp = $null
if (-not $Dir -or -not (Test-Path (Join-Path $Dir 'install.cjs'))) {
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  Write-Host "내려받는 중: $RepoUrl ($Branch)"
  try {
    $Zip = Join-Path $Tmp 'src.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "$RepoUrl/archive/refs/heads/$Branch.zip" -OutFile $Zip
    Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  } catch {
    Write-Host "저장소를 내려받지 못했습니다: $($_.Exception.Message) 네트워크를 확인한 뒤 다시 실행하세요."
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
    return
  }
  $Found = Get-ChildItem -Path $Tmp -Directory | ForEach-Object { Join-Path $_.FullName 'herdr' } | Where-Object { Test-Path (Join-Path $_ 'install.cjs') } | Select-Object -First 1
  if (-not $Found) {
    Write-Host '내려받은 파일에서 herdr\install.cjs를 찾지 못했습니다.'
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
    return
  }
  $Dir = $Found
}
$Cjs = Join-Path $Dir 'install.cjs'

# Windows PowerShell 5.1은 Stop 상태에서 외부 명령의 stderr 한 줄을 종료 오류로 만들므로 try로 감싸고 종료 코드만 본다.
function Invoke-Helper([string[]]$HelperArgs) {
  try { $Out = & node $Cjs @HelperArgs 2>&1 | Out-String; return @{ Code = $LASTEXITCODE; Out = $Out } }
  catch { return @{ Code = 1; Out = $_.Exception.Message } }
}

try {
  # 목록과 제거는 레이아웃 복제가 필요 없어 여기서 끝난다. 도우미가 2로 끝나면(잘못된 이름 등) 그 안내만 보여 준다.
  if ($List) {
    $R = Invoke-Helper @('list', '--home', $AppHome)
    Write-Host -NoNewline $R.Out
    return
  }
  if ($Remove) {
    $R = Invoke-Helper @('remove', '--home', $AppHome, '--mods', ($Remove -join ','))
    Write-Host -NoNewline $R.Out
    if ($R.Code -ne 0 -and $R.Code -ne 2) { Write-Host '모드를 지우지 못했습니다.' }
    # PO 훅(inbox): Claude Code 설정의 한 줄을 뺀다. 다른 훅은 건드리지 않는다.
    if ($Remove -contains 'inbox') {
      $R = Invoke-Helper @('hook', '--home', $AppHome, '--remove')
      Write-Host -NoNewline $R.Out
    }
    return
  }

  # 1) 모드 복사
  $ModArgs = @('mods', '--home', $AppHome)
  if ($Extras) { $ModArgs += '--extras' }
  elseif ($Only) { $ModArgs += @('--only', ($Only -join ',')) }
  elseif ($Add) { $ModArgs += @('--add', ($Add -join ',')) }
  $R = Invoke-Helper $ModArgs
  Write-Host -NoNewline $R.Out
  if ($R.Code -eq 2) { return }
  if ($R.Code -ne 0) { Write-Host '모드를 복사하지 못했습니다.'; return }
  # PO 훅(inbox): Claude Code 설정(~\.claude\settings.json, CLAUDE_CONFIG_DIR이 있으면 그 폴더)의 Stop·UserPromptSubmit에 한 줄을 넣는다. 실패해도 설치는 계속한다.
  if (Test-Path (Join-Path $AppHome 'mods\inbox\po-hook.cjs')) {
    $H = Invoke-Helper @('hook', '--home', $AppHome)
    Write-Host -NoNewline $H.Out
    if ($H.Code -ne 0) { Write-Host 'PO 훅을 설정에 넣지 못했습니다(PO 답이 데스크에 자동으로 올라오지 않습니다).' }
  }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Write-Host 'gh가 없어 Work·PRs 패널은 GitHub 데이터를 불러오지 못합니다. GitHub CLI를 설치하고 로그인하세요.' }

  # 2) 레이아웃. 우리 레이아웃이 없으면 실행 중인 앱에서 기본 레이아웃(main)을 복제한다.
  $R = Invoke-Helper @('pending-layout', '--home', $AppHome)
  $Name = if ($R.Code -eq 0) { $R.Out.Trim() } else { '' }
  if (-not $Name) {
    $R = Invoke-Helper @('layout', '--home', $AppHome)
    Write-Host -NoNewline $R.Out
    return
  }
  $Running = $false
  if (Get-Command herdr-app -ErrorAction SilentlyContinue) {
    try { & herdr-app status *> $null; $Running = ($LASTEXITCODE -eq 0) } catch { $Running = $false }
  }
  if (-not $Running) {
    Write-Host '실행 중인 Herdr 앱을 찾지 못해 레이아웃은 만들지 않았습니다. 앱을 켠 뒤 이 스크립트를 다시 실행하세요.'
    return
  }
  $Arg = @{ name = 'main'; as = $Name } | ConvertTo-Json -Compress
  # 5.1은 외부 명령 인자의 큰따옴표를 이스케이프하지 않으므로 직접 \"로 바꿔 넘긴다.
  if ($PSVersionTable.PSVersion.Major -lt 7) { $Arg = $Arg.Replace('"', '\"') }
  $Out = ''
  $Code = 1
  try { $Out = & herdr-app do layout.clone $Arg 2>&1 | Out-String; $Code = $LASTEXITCODE } catch { $Out = $_.Exception.Message }
  if ($Code -ne 0) { Write-Host "layout.clone 실패: $Out 레이아웃은 만들지 않았습니다."; return }
  $Layout = Join-Path $AppHome "layouts\$Name.json"
  if (-not (Test-Path $Layout)) { Write-Host "layout.clone 뒤에도 $Layout 이(가) 없습니다: $Out"; return }
  Write-Host "레이아웃 생성: $Layout (지금 이 레이아웃으로 바뀌었습니다. 다른 레이아웃으로 가려면 ctrl-shift-l)"
  $R = Invoke-Helper @('layout', '--home', $AppHome, '--created')
  Write-Host -NoNewline $R.Out
} finally {
  if ($Tmp) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp }
}
return
