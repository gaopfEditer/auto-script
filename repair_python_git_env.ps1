# Fix pip warnings and distutils-precedence.pth (run from script folder)
$site = "D:\dev\python\Lib\site-packages"

Write-Host "Remove broken ~t_dlp metadata..."
Get-ChildItem $site -Force | Where-Object { $_.Name -like "~t_dlp*" } | ForEach-Object {
    Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    Write-Host "  removed $($_.Name)"
}

Write-Host "Rewrite distutils-precedence.pth..."
$pth = Join-Path $site "distutils-precedence.pth"
$line = "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim(); "
[System.IO.File]::WriteAllText($pth, ($line + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding $false))

Write-Host "Reinstall setuptools..."
python -m pip install --force-reinstall setuptools

Write-Host "Python check..."
python -c "import site; print('site OK')"

Write-Host "Git check..."
git config --list --show-origin 2>&1 | Select-Object -First 3
Write-Host "Done."
