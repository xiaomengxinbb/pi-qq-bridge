import urllib.request, ssl, re, html, json
ctx = ssl.create_default_context()
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0'}
def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout, context=ctx).read().decode('utf-8', errors='ignore')

try:
    t = fetch('https://forum.koishi.xyz/t/topic/5887.json')
    d = json.loads(t)
    posts = d.get('post_stream', {}).get('posts', [])
    print('POSTS', len(posts))
    blob = '\n'.join(p.get('cooked', '') for p in posts[:15])
    blob = re.sub(r'<[^>]+>', '\n', blob)
    blob = html.unescape(blob)
    blob = re.sub(r'\n{2,}', '\n', blob)
    for kw in ['提审', '上线', '发布', '审核', '拒']:
        i = blob.find(kw)
        if i >= 0:
            print('=== KW:', kw, '===')
            print(blob[max(0,i-300):i+800])
            print()
except Exception as e:
    print('ERR', e)
