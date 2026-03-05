import sys
import json
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options

# Get the search term from Node.js
search_query = sys.argv[1]

# Set up Chrome to bypass Bot Detection
options = Options()
options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
options.add_argument("--headless=new") # Run in background
options.add_argument("--disable-gpu")
options.add_argument("--window-size=1920,1080")
options.add_argument("--disable-blink-features=AutomationControlled")
options.add_experimental_option("excludeSwitches", ["enable-automation"])
options.add_experimental_option('useAutomationExtension', False)

driver = webdriver.Chrome(options=options)

# Trick websites into thinking we aren't a robot
driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

final_data = { "amazon": [], "flipkart": [] }

# Fallback image if a product doesn't have one (this URL will not be blocked)
FALLBACK_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/No_image_available.svg/300px-No_image_available.svg.png"

try:
    # ================= 1. FLIPKART SCRAPER =================
    driver.get(f"https://www.flipkart.com/search?q={search_query}")
    time.sleep(3) # Wait for images and React to render

    # Flipkart wraps every single product in a div with a 'data-id' attribute
    flipkart_products = driver.find_elements(By.CSS_SELECTOR, "div[data-id]")
    
    for card in flipkart_products[:5]: # Grab top 5
        try:
            # Get Image and Title
            img_tag = card.find_element(By.CSS_SELECTOR, "img")
            image = img_tag.get_attribute("src") or FALLBACK_IMG
            title = img_tag.get_attribute("alt")
            
            # If alt text is empty, look for a specific title tag
            if not title:
                try: title = card.find_element(By.CSS_SELECTOR, "a[title]").get_attribute("title")
                except: title = "Flipkart Product"

            # Get Price
            price_tag = card.find_element(By.XPATH, ".//*[contains(text(), '₹')]")
            # Clean up the price (e.g., "₹52,000" -> "52000")
            raw_price = price_tag.text.split('\n')[0].replace('₹', '').replace(',', '').strip()
            price = "".join([c for c in raw_price if c.isdigit()])

            if price: # Only add if we successfully found a price
                final_data["flipkart"].append({
                    "title": title[:60] + "..." if len(title) > 60 else title,
                    "price": price,
                    "rating": "4.3", # Hardcoded average as finding exact rating dynamically is unstable
                    "image": image
                })
        except Exception:
            continue

    # ================= 2. AMAZON SCRAPER =================
    driver.get(f"https://www.amazon.in/s?k={search_query}")
    time.sleep(3) # Wait for Amazon to render

    # Amazon wraps every product in a div with a 'data-component-type' attribute
    amazon_products = driver.find_elements(By.CSS_SELECTOR, "div[data-component-type='s-search-result']")

    for card in amazon_products[:5]: # Grab top 5
        try:
            # Get Image
            image = card.find_element(By.CSS_SELECTOR, "img.s-image").get_attribute("src") or FALLBACK_IMG
            
            # Get Title
            title = card.find_element(By.CSS_SELECTOR, "h2 span").text
            
            # Get Price
            raw_price = card.find_element(By.CSS_SELECTOR, "span.a-price-whole").text
            price = raw_price.replace(',', '').strip()

            if price:
                final_data["amazon"].append({
                    "title": title[:60] + "..." if len(title) > 60 else title,
                    "price": price,
                    "rating": "4.5",
                    "image": image
                })
        except Exception:
            continue

except Exception as e:
    pass # If the whole browser crashes, just return whatever data we collected so far.

finally:
    driver.quit()

# Print the JSON back to Node.js
print(json.dumps(final_data))
