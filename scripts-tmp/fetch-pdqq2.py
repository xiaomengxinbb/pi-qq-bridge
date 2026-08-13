import urllib.request, ssl, re, html
ctx = ssl.create_default_context()
url = 'https://pd.qq.com/g/20dnumts4z/post/B_3f3340674a9409001441152186800517180X60'
req = urllib.request.Request('https://r.jina.ai/' + url, headers={'User-Agent': 'Mozilla/5.0', 'X-Return-Format': 'markdown'})
try:
    t = urllib.request.urlopen(req, timeout=60, context=ctx).read().decode('utf-8', errors='ignore')
    print('LEN', len(t))
    for kw in ['提审', '拒审', '上线', '发布', '审核', '资质', '名称', '简介', '图标']:
        i = t.find(kw)
        if i >= 0:
            print('=== KW:', kw, '===')
            print(t[max(0,i-250):i+900])
            print()
except Exception as e:
    print('ERR', e)
