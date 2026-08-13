import re, html, urllib.request

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    return urllib.request.urlopen(req, timeout=20).read().decode('utf-8', errors='ignore')

def text(t):
    t = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<style[^>]*>.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '\n', t)
    t = html.unescape(t)
    t = re.sub(r'\n{2,}', '\n', t)
    return t

# 1. 萌新申请群机器人拒审保姆级教程
try:
    t = text(fetch('https://pd.qq.com/g/20dnumts4z/post/B_3f3340674a9409001441152186800517180X60'))
    for kw in ['提审', '审核', '上线', '拒审', '资料', '名称', '简介']:
        i = t.find(kw)
        if i >= 0:
            print('=== KW:', kw, '===')
            print(t[max(0,i-200):i+800])
            print()
except Exception as e:
    print('ERR1', e)
