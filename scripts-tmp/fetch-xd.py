import urllib.request, ssl, re, html
ctx = ssl.create_default_context()
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0'}
req = urllib.request.Request('https://www.xiaoduoai.com/blog/docs/uys1dy', headers=UA)
t = urllib.request.urlopen(req, timeout=30, context=ctx).read().decode('utf-8', errors='ignore')
t = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
t = re.sub(r'<style[^>]*>.*?</style>', '', t, flags=re.S)
t = re.sub(r'<[^>]+>', '\n', t)
t = html.unescape(t)
t = re.sub(r'\n{2,}', '\n', t)
i = t.find('审核')
print(t[max(0,i-2000):i+2500])
