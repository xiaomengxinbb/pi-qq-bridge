import urllib.request, ssl, re
ctx = ssl.create_default_context()
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0'}
url = 'https://pd.qq.com/g/20dnumts4z/post/B_3f3340674a9409001441152186800517180X60'
req = urllib.request.Request(url, headers=UA)
t = urllib.request.urlopen(req, timeout=30, context=ctx).read().decode('utf-8', errors='ignore')
print('LEN', len(t))
# look for embedded json / content markers
for pat in ['__INITIAL', 'initialState', 'post_content', 'content":', '拒审', 'title', 'B_3f334']:
    idxs = [m.start() for m in re.finditer(re.escape(pat), t)][:3]
    print(pat, idxs)
i = t.find('拒审')
if i > 0:
    print(t[max(0,i-500):i+1500])
else:
    # print first interesting chunk
    j = t.find('B_3f3340674a9409001441152186800517180X60')
    print(t[max(0,j-200):j+2000])
