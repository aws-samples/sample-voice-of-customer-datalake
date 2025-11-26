#!/usr/bin/env python3
"""
Demo script to show Trustpilot JSON-LD data structure vs what we extract.
Run: python3 scripts/demo_trustpilot_jsonld.py
"""
import requests
from bs4 import BeautifulSoup
import json

url = "https://www.trustpilot.com/review/lufthansa.com"
headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
}

print("Fetching Trustpilot page...")
response = requests.get(url, headers=headers, timeout=30)
soup = BeautifulSoup(response.text, 'html.parser')

# Find JSON-LD scripts
scripts = soup.find_all('script', type='application/ld+json')

print("=" * 80)
print("TRUSTPILOT JSON-LD DATA STRUCTURE")
print("=" * 80)

for i, script in enumerate(scripts):
    try:
        data = json.loads(script.string)
        
        # Handle @graph structure
        if isinstance(data, dict) and '@graph' in data:
            items = data['@graph']
        elif isinstance(data, list):
            items = data
        else:
            items = [data]
        
        for item in items:
            item_type = item.get('@type', '')
            if item_type == 'Review':
                print("\n" + "=" * 80)
                print("RAW REVIEW JSON-LD (first review found):")
                print("=" * 80)
                print(json.dumps(item, indent=2))
                
                print("\n" + "=" * 80)
                print("WHAT WE CURRENTLY EXTRACT:")
                print("=" * 80)
                
                # Current extraction
                text = item.get('reviewBody', '')
                title = item.get('headline', item.get('name', ''))
                
                rating = None
                rating_value = item.get('reviewRating', {})
                if isinstance(rating_value, dict):
                    rating = rating_value.get('ratingValue')
                
                author = 'Anonymous'
                author_url = None
                author_data = item.get('author', {})
                if isinstance(author_data, dict):
                    author = author_data.get('name', 'Anonymous')
                    author_url = author_data.get('url')
                
                created_at = item.get('datePublished', '')
                review_url = item.get('url', url)
                
                print(f"title: {title}")
                print(f"text: {text[:200]}..." if len(text) > 200 else f"text: {text}")
                print(f"rating: {rating}")
                print(f"author: {author}")
                print(f"author_url: {author_url}")
                print(f"created_at: {created_at}")
                print(f"review_url: {review_url}")
                
                print("\n" + "=" * 80)
                print("ALL AVAILABLE FIELDS IN JSON-LD:")
                print("=" * 80)
                for key, value in item.items():
                    if isinstance(value, dict):
                        print(f"{key}: {json.dumps(value)}")
                    elif isinstance(value, str) and len(value) > 100:
                        print(f"{key}: {value[:100]}...")
                    else:
                        print(f"{key}: {value}")
                
                # Exit after first review
                print("\n\nRun complete. Check the output above to see available fields.")
                exit(0)
    except Exception as e:
        print(f"Error parsing script {i}: {e}")

print("No reviews found in JSON-LD")
