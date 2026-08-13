import urllib.request, ssl, re, html, json
ctx = ssl.create_default_context()
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0'}
def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout, context=ctx).read().decode('utf-8', errors='ignore')

d = json.loads(fetch('https://forum.koishi.xyz/t/topic/5887.json'))
posts = d.get('post_stream', {}).get('posts', [])
for p in posts[1:]:
    blob = re.sub(r'<[^>]+>', '\n', p.get('cooked', ''))
    blob = html.unescape(blob)
    blob = re.sub(r'\n{2,}', '\n', blob)
    print('===== POST', p.get('post_number'), p.get('name'), '=====')
    print(blob[:1800])
    print()
