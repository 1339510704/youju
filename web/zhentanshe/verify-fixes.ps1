# 部署后验证脚本
$base = "https://zhentanshe.robai.dpdns.org"

Write-Host "验证修复结果..."
Write-Host ""

# 测试 1: /api/watch/list 别名
Write-Host "1. 测试监测列表 API..."
try {
    $r = Invoke-RestMethod "$base/api/watch/list" -TimeoutSec 20
    if($r.ok) {
        Write-Host "   ✓ /api/watch/list 正常返回 JSON"
        Write-Host "   监测项数量: $($r.watches.Count)"
    }
} catch {
    Write-Host "   ✗ 请求失败: $_"
}

# 测试 2: 前端文案更新
Write-Host ""
Write-Host "2. 检查前端文案..."
$html = Invoke-WebRequest "$base/?nocache=$(Get-Random)" -TimeoutSec 20
if($html.Content -match "Jev 裁决功能未启用") {
    Write-Host "   ✓ 前端文案已更新"
} elseif($html.Content -match "BOCHA_JEV_API_KEY") {
    Write-Host "   ⚠ 仍显示旧文案（可能需要清除 CDN 缓存）"
} else {
    Write-Host "   ? 无法确认状态"
}

# 测试 3: 功能健康检查
Write-Host ""
Write-Host "3. 功能健康检查..."
$endpoints = @(
    @{name="元宝搜索"; url="/api/search?q=test&cnt=10&mode=2"},
    @{name="博查搜索"; url="/api/bocha?q=test&count=5"},
    @{name="Jev健康"; url="/api/jev/health"},
    @{name="信誉系统"; url="/api/reputation"}
)

foreach($ep in $endpoints) {
    try {
        $r = Invoke-RestMethod "$base$($ep.url)" -TimeoutSec 20
        Write-Host ("   {0,-12} {1}" -f $ep.name, $(if($r.ok){"✓"}else{"✗"}))
    } catch {
        Write-Host ("   {0,-12} ✗" -f $ep.name)
    }
}

Write-Host ""
Write-Host "验证完成！"
