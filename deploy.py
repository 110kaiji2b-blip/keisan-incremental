# -*- coding: utf-8 -*-
"""ダブルクリックで GitHub Pages に反映するためのスクリプト。

deploy.bat から呼ばれる。やっていることは
    公開用ファイルを作る → git add → git commit → git push
の4つだけ。
"""
import datetime
import os
import subprocess
import sys

DRY = '--dry' in sys.argv     # 動作確認用。実際の push はしない

# 日本語が文字化けしないように（deploy.bat 側で chcp 65001 している）
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def git(*args, **kw):
    return subprocess.run(['git', *args], **kw)


print('==========================================')
print('  計算するインクリメンタルゲーム ・ 更新')
print('==========================================')
print()

if git('rev-parse', '--is-inside-work-tree', capture_output=True).returncode != 0:
    print('このフォルダは git の管理下にありません。')
    sys.exit(1)

remote = git('remote', 'get-url', 'origin', capture_output=True, text=True)
if remote.returncode != 0:
    print('GitHub のリポジトリがまだ設定されていません。')
    print('次の1行を一度だけ実行してください:')
    print()
    print('    git remote add origin https://github.com/ユーザー名/リポジトリ名.git')
    sys.exit(1)

print('公開用ファイルを作りなおしています...')
subprocess.run([sys.executable, 'build_artifact.py'])
print()

git('add', '-A')
if git('diff', '--cached', '--quiet').returncode == 0:
    # 新しい変更が無くても、まだ送っていない分があるかもしれないので先へ進む
    print('新しい変更はありませんでした。')
else:
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    git('commit', '-m', f'更新 {stamp}')

print()
print('アップロードしています...')
if DRY:
    print('（--dry なので push はしません）')
    sys.exit(0)
# -u を付けておくと、初回でも2回目以降でもこの1行で通る
if git('push', '-u', 'origin', 'HEAD').returncode != 0:
    print()
    print('*** 失敗しました。上のメッセージを確認してください ***')
    print('初回はブラウザで GitHub へのログインを求められます。')
    sys.exit(1)

print()
print('完了しました。1〜2分で公開ページに反映されます。')
url = remote.stdout.strip()
if url.endswith('.git'):
    url = url[:-4]
if 'github.com/' in url:
    user, repo = url.split('github.com/')[-1].split('/')[:2]
    print(f'    https://{user}.github.io/{repo}/')
