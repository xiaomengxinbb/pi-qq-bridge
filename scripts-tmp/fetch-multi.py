import urllib.request, ssl, re, html
ctx = ssl.create_default_context()
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0'}

def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout, context=ctx).read().decode('utf-8', errors='ignore')

def text(t):
    t = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<style[^>]*>.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '\n', t)
    t = html.unescape(t)
    t = re.sub(r'\n{2,}', '\n', t)
    return t

targets = [
    ('cc-connect', 'https://raw.githubusercontent.com/chenhg5/cc-connect/main/docs/qqbot.md'),
    ('olivos', 'https://forum.olivos.run/d/668-bot'),
    ('xiaoduoai', 'https://www.xiaoduoai.com/blog/docs/uys1dy'),
]
for name, url in targets:
    try:
        t = text(fetch(url))
        print('##########', name, len(t))
        hits = 0
        for kw in ['提审', '审核', '上线', '发布', '上架', '拒审']:
            i = 0
            while True:
                i = t.find(kw, i)
                if i < 0 or hits > 12:
                    break
                print('---', kw, '---')
                print(t[max(0,i-200):i+600])
                hits += 1
                i += len(kw)
        if hits == 0:
            print(t[:1500])
    except Exception as e:
        print('ERR', name, e)
