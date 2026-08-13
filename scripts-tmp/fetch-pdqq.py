import re, html, urllib.request, ssl

ctx = ssl.create_default_context()
url = 'https://pd.qq.com/g/20dnumts4z/post/B_3f3340674a9409001441152186800517180X60'

def fetch(url, ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'):
    req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9'})
    return urllib.request.urlopen(req, timeout=25, context=ctx).read().decode('utf-8', errors='ignore')

try:
    t = fetch(url)
    print('LEN', len(t))
    t2 = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
    t2 = re.sub(r'<style[^>]*>.*?</style>', '', t2, flags=re.S)
    t2 = re.sub(r'<[^>]+>', '\n', t2)
    t2 = html.unescape(t2)
    t2 = re.sub(r'\n{2,}', '\n', t2)
    for kw in ['提审', '拒审', '上线', '发布', '审核']:
        i = t2.find(kw)
        if i >= 0:
            print('=== KW:', kw, '===')
            print(t2[max(0,i-250):i+900])
            print()
except Exception as e:
    print('ERR', e)
    # fallback: jina proxy
    try:
        t = fetch('https://r.jina.ai/' + url)
        print('JINA LEN', len(t))
        print(t[:4000])
    except Exception as e2:
        print('ERR2', e2)
