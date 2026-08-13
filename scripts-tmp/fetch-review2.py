import re, html, urllib.request, ssl

ctx = ssl.create_default_context()

def fetch(url, ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'):
    req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept': '*/*'})
    return urllib.request.urlopen(req, timeout=20, context=ctx).read().decode('utf-8', errors='ignore')

def text(t):
    t = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<style[^>]*>.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '\n', t)
    t = html.unescape(t)
    t = re.sub(r'\n{2,}', '\n', t)
    return t

urls = [
    ('astrbot', 'https://raw.githubusercontent.com/NanoRocky/AstrBot-b/master/docs/zh/platform/qqofficial/websockets.md'),
    ('openclaw', 'https://openclawlaunch.com/zh/qq'),
    ('workbuddy', 'https://www.w3cschool.cn/workbuddydocs/workbuddy-qq-guide.html'),
]
for name, url in urls:
    try:
        t = text(fetch(url))
        print('##########', name, len(t))
        for kw in ['提审', '审核', '上线', '发布', '资料', '简介', '头像', '服务条款', '功能']:
            i = t.find(kw)
            if i >= 0:
                print('--- KW:', kw, '---')
                print(t[max(0,i-150):i+700])
                print()
    except Exception as e:
        print('ERR', name, e)
