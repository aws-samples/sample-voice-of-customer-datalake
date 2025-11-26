#!/usr/bin/env python3
"""
Test what HTML Lambda receives from Skytrax.
This simulates the Lambda environment.
"""
import requests
from bs4 import BeautifulSoup

# Use the same headers as Lambda
headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
}

url = 'https://www.airlinequality.com/airline-reviews/lufthansa/'

print(f"Fetching: {url}")
print(f"Headers: {headers}\n")

try:
    resp = requests.get(url, headers=headers, timeout=30)
    print(f"Status: {resp.status_code}")
    print(f"Content-Length: {len(resp.text)} bytes")
    print(f"Content-Type: {resp.headers.get('Content-Type')}")
    
    if resp.status_code == 200:
        soup = BeautifulSoup(resp.text, 'html.parser')
        
        # Check for the selector
        containers = soup.select('article.comp_media-review-rated')
        print(f"\nContainers found: {len(containers)}")
        
        if not containers:
            # Debug: what's in the page?
            print("\n--- Page Structure Debug ---")
            
            # Check for articles
            articles = soup.find_all('article')
            print(f"Total <article> tags: {len(articles)}")
            if articles:
                for i, a in enumerate(articles[:3]):
                    classes = a.get('class', [])
                    print(f"  Article {i+1}: classes={classes}")
            
            # Check for review-like content
            review_divs = soup.find_all('div', class_=lambda x: x and 'review' in str(x).lower() if x else False)
            print(f"\nDivs with 'review' in class: {len(review_divs)}")
            if review_divs:
                for i, d in enumerate(review_divs[:3]):
                    print(f"  Div {i+1}: {d.get('class')}")
            
            # Check page title
            title = soup.title.string if soup.title else 'No title'
            print(f"\nPage title: {title}")
            
            # Check for JavaScript/SPA indicators
            scripts = soup.find_all('script')
            print(f"\nScript tags: {len(scripts)}")
            
            # Check for common bot detection
            if 'cloudflare' in resp.text.lower():
                print("\n⚠️  Cloudflare detected in response")
            if 'captcha' in resp.text.lower():
                print("\n⚠️  CAPTCHA detected in response")
            if 'access denied' in resp.text.lower():
                print("\n⚠️  'Access Denied' found in response")
            
            # Save HTML for inspection
            output_file = '/tmp/skytrax_lambda_response.html'
            with open(output_file, 'w') as f:
                f.write(resp.text)
            print(f"\n✓ Saved full HTML to {output_file}")
            
            # Show first 2000 chars
            print("\n--- First 2000 chars of response ---")
            print(resp.text[:2000])
        else:
            print("\n✓ Containers found! Extraction should work.")
            for i, c in enumerate(containers[:2]):
                text_elem = c.select_one('.text_content')
                if text_elem:
                    text = text_elem.get_text(strip=True)[:100]
                    print(f"  Review {i+1}: {text}...")
    else:
        print(f"\n✗ HTTP {resp.status_code}")
        print(resp.text[:500])
        
except Exception as e:
    print(f"\n✗ Error: {e}")
    import traceback
    traceback.print_exc()
