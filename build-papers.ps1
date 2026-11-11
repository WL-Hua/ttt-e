$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot 'test'
$files = @(Get-ChildItem -LiteralPath $directory -Filter '*.docx' -File | Sort-Object Name)
if ($files.Count -eq 0) { throw "No DOCX files found in $directory." }
$papers = @($files | ForEach-Object {
    $item = [ordered]@{
        name = $_.Name
        data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
    }
    $reference = [IO.Path]::ChangeExtension($_.FullName, '.pdf')
    if (Test-Path -LiteralPath $reference -PathType Leaf) {
        $item.referencePdf = [Convert]::ToBase64String([IO.File]::ReadAllBytes($reference))
    }
    $item
})
$json = ConvertTo-Json -InputObject $papers -Compress -Depth 3
$output = "window.BUNDLED_DOCX = $json;`n"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bundled-papers.js'), $output, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Bundled $($files.Count) DOCX files."
