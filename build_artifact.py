"""index.html から公開用の artifact.html を作る。

Artifact は <html>/<head>/<body> を自動で付けるので、
index.html の <body> の中身と <title> だけを取り出して書き出す。

    python build_artifact.py
"""
import io
import re

src = io.open('index.html', encoding='utf-8').read()

title = re.search(r'<title>(.*?)</title>', src, re.S).group(1).strip()
body = re.search(r'<body>(.*)</body>', src, re.S).group(1).strip()
link = re.search(r'<link[^>]*href="style\.css"[^>]*>', src).group(0)

out = f'<title>{title}</title>\n{link}\n\n{body}\n'
io.open('artifact.html', 'w', encoding='utf-8').write(out)
print(f'artifact.html を書き出しました（{len(out)} 文字）')
