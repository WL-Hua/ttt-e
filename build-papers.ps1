$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot 'test'
$files = @(Get-ChildItem -LiteralPath $directory -Filter '*.docx' -File | Where-Object { $_.Name -ine 'interview.docx' } | Sort-Object Name)
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

$interviewFile = Join-Path $directory 'interview.docx'
if (Test-Path -LiteralPath $interviewFile -PathType Leaf) {
    $translationNames = [ordered]@{
        scenic = 'interview-translation-scenic.json'
        guide = 'interview-translation-guide.json'
        special = 'interview-translation-special.json'
        knowledge = 'interview-translation-knowledge.json'
        'zh-en' = 'interview-translation-zh-en.json'
        'en-zh' = 'interview-translation-en-zh.json'
    }
    $translations = [ordered]@{}
    foreach ($category in $translationNames.Keys) {
        $translationPath = Join-Path $directory $translationNames[$category]
        if (-not (Test-Path -LiteralPath $translationPath -PathType Leaf)) {
            throw "Missing interview translation file: $translationPath"
        }
        $translation = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($translationPath, [Text.Encoding]::UTF8))
        if ($translation.category -cne $category -or -not ($translation.items -is [array])) {
            throw "Invalid interview translation file: $translationPath"
        }
        $translations[$category] = $translation
    }
    $interviewBundle = [ordered]@{
        data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($interviewFile))
        translations = $translations
    }
    $interviewJson = ConvertTo-Json -InputObject $interviewBundle -Compress -Depth 20
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bundled-interview.js'), "window.BUNDLED_INTERVIEW = $interviewJson;`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Bundled interview.docx and $($translations.Count) translation sections."
}
