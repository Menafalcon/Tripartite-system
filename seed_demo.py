"""
Run this once to add a demo account with 10 properties, 10 store items, and 10 farms.
Usage: python seed_demo.py
Login: demo / demo123
"""
import json, os, datetime

DATA_FILE = 'data.json'

def load():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"users": {}}

def save(data):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def now():
    return datetime.datetime.now().isoformat()

def make_units():
    return [
        {"id":1,"prop_id":"APT-A101","unit_num":"101","is_vacant":False,"fname":"Ahmed","lname":"Ben Ali","tenant_id":"12345678","phone":"+216 71 234 567","email":"ahmed.benali@email.com","rent":1200,"rent_status":"paid","water":45,"electric":110,"tax":120,"water_landlord":False,"electric_landlord":False,"tax_landlord":True,"due_date":"2026-07-01","notes":"Long-term tenant since 2020"},
        {"id":2,"prop_id":"APT-A102","unit_num":"102","is_vacant":False,"fname":"Fatima","lname":"Trabelsi","tenant_id":"23456789","phone":"+216 72 345 678","email":"fatima.t@email.com","rent":900,"rent_status":"unpaid","water":38,"electric":95,"tax":90,"water_landlord":False,"electric_landlord":True,"tax_landlord":True,"due_date":"2026-06-01","notes":"Late payment — follow up needed"},
        {"id":3,"prop_id":"APT-B201","unit_num":"201","is_vacant":False,"fname":"Mohamed","lname":"Salah","tenant_id":"34567890","phone":"+216 73 456 789","email":"m.salah@email.com","rent":1500,"rent_status":"paid","water":60,"electric":140,"tax":150,"water_landlord":False,"electric_landlord":False,"tax_landlord":True,"due_date":"2026-07-01","notes":""},
        {"id":4,"prop_id":"APT-B202","unit_num":"202","is_vacant":False,"fname":"Leila","lname":"Mansouri","tenant_id":"45678901","phone":"+216 74 567 890","email":"leila.m@email.com","rent":800,"rent_status":"partial","water":30,"electric":75,"tax":80,"water_landlord":False,"electric_landlord":False,"tax_landlord":False,"due_date":"2026-06-15","notes":"Paid 400 DT partial"},
        {"id":5,"prop_id":"APT-C301","unit_num":"301","is_vacant":False,"fname":"Omar","lname":"Cherif","tenant_id":"56789012","phone":"+216 75 678 901","email":"omar.c@email.com","rent":1100,"rent_status":"paid","water":42,"electric":100,"tax":110,"water_landlord":True,"electric_landlord":False,"tax_landlord":True,"due_date":"2026-07-01","notes":""},
        {"id":6,"prop_id":"APT-C302","unit_num":"302","is_vacant":True,"fname":"","lname":"","tenant_id":"","phone":"","email":"","rent":950,"rent_status":"paid","water":0,"electric":0,"tax":0,"water_landlord":False,"electric_landlord":False,"tax_landlord":False,"due_date":"","notes":"Renovating — available August 2026"},
        {"id":7,"prop_id":"APT-D401","unit_num":"401","is_vacant":False,"fname":"Nadia","lname":"Bouali","tenant_id":"67890123","phone":"+216 76 789 012","email":"nadia.b@email.com","rent":1300,"rent_status":"unpaid","water":50,"electric":125,"tax":130,"water_landlord":False,"electric_landlord":False,"tax_landlord":True,"due_date":"2026-06-01","notes":"Two months overdue"},
        {"id":8,"prop_id":"APT-D402","unit_num":"402","is_vacant":False,"fname":"Karim","lname":"Jebali","tenant_id":"78901234","phone":"+216 77 890 123","email":"karim.j@email.com","rent":700,"rent_status":"paid","water":25,"electric":65,"tax":70,"water_landlord":False,"electric_landlord":False,"tax_landlord":False,"due_date":"2026-07-01","notes":"Student, always on time"},
        {"id":9,"prop_id":"APT-E501","unit_num":"501","is_vacant":False,"fname":"Sonia","lname":"Hamdi","tenant_id":"89012345","phone":"+216 78 901 234","email":"sonia.h@email.com","rent":1000,"rent_status":"paid","water":40,"electric":90,"tax":100,"water_landlord":False,"electric_landlord":False,"tax_landlord":True,"due_date":"2026-07-01","notes":""},
        {"id":10,"prop_id":"APT-E502","unit_num":"502","is_vacant":True,"fname":"","lname":"","tenant_id":"","phone":"","email":"","rent":850,"rent_status":"paid","water":0,"electric":0,"tax":0,"water_landlord":False,"electric_landlord":False,"tax_landlord":False,"due_date":"","notes":"Available immediately"},
    ]

def make_store():
    return [
        {"id":1,"name":"Samsung TV 55\"","description":"4K Smart TV","buy_price":800,"sell_price":1200,"quantity":3,"image":None,"sales":[]},
        {"id":2,"name":"Dell Laptop 15\"","description":"Core i7, 16GB RAM, 512GB SSD","buy_price":900,"sell_price":1400,"quantity":2,"image":None,"sales":[
            {"id":"s1","quantity":1,"total_price":1400,"amount_paid":1400,"remaining":0,"status":"sold","date":now(),"discount_pct":0,"payments":[{"amount":1400,"date":now()}]}
        ]},
        {"id":3,"name":"iPhone 14","description":"128GB, Midnight Black","buy_price":700,"sell_price":1100,"quantity":5,"image":None,"sales":[
            {"id":"s2","quantity":2,"total_price":2200,"amount_paid":1100,"remaining":1100,"status":"installment","date":now(),"discount_pct":0,"payments":[{"amount":1100,"date":now()}]}
        ]},
        {"id":4,"name":"PlayStation 5","description":"Disc edition, 1TB","buy_price":550,"sell_price":750,"quantity":1,"image":None,"sales":[]},
        {"id":5,"name":"LG Refrigerator","description":"Double door, 450L","buy_price":600,"sell_price":900,"quantity":4,"image":None,"sales":[
            {"id":"s3","quantity":1,"total_price":900,"amount_paid":900,"remaining":0,"status":"sold","date":now(),"discount_pct":0,"payments":[{"amount":900,"date":now()}]}
        ]},
        {"id":6,"name":"Washing Machine","description":"7kg, Front loader","buy_price":450,"sell_price":700,"quantity":2,"image":None,"sales":[]},
        {"id":7,"name":"Air Conditioner","description":"1.5 ton, Inverter","buy_price":500,"sell_price":800,"quantity":3,"image":None,"sales":[]},
        {"id":8,"name":"Microwave Oven","description":"25L, Digital panel","buy_price":120,"sell_price":200,"quantity":6,"image":None,"sales":[
            {"id":"s4","quantity":2,"total_price":400,"amount_paid":400,"remaining":0,"status":"sold","date":now(),"discount_pct":0,"payments":[{"amount":400,"date":now()}]}
        ]},
        {"id":9,"name":"Sony Headphones","description":"WH-1000XM5, Noise cancelling","buy_price":80,"sell_price":150,"quantity":8,"image":None,"sales":[]},
        {"id":10,"name":"Smart Watch","description":"Health tracking, GPS","buy_price":200,"sell_price":350,"quantity":4,"image":None,"sales":[
            {"id":"s5","quantity":1,"total_price":315,"amount_paid":315,"remaining":0,"status":"sold","date":now(),"discount_pct":10,"payments":[{"amount":315,"date":now()}]}
        ]},
    ]

def make_farms():
    return [
        {"id":1,"name":"Sfax Olive Farm","location":"Sfax","size_ha":5,"crop_type":"Olives","workers":[{"name":"Ali Karray","daily_cost":35,"days":60}],"harvest_projections":[{"year":2026,"expected_kg":8000,"price_per_kg":1.8}],"notes":"Premium extra-virgin olive oil production"},
        {"id":2,"name":"Nabeul Citrus Farm","location":"Nabeul","size_ha":3,"crop_type":"Oranges","workers":[{"name":"Hedi Sassi","daily_cost":30,"days":45}],"harvest_projections":[{"year":2026,"expected_kg":5000,"price_per_kg":0.9}],"notes":"Export quality citrus"},
        {"id":3,"name":"Bizerte Wheat Fields","location":"Bizerte","size_ha":10,"crop_type":"Wheat","workers":[{"name":"Mounir Bel Haj","daily_cost":40,"days":30},{"name":"Rafik Gara","daily_cost":38,"days":30}],"harvest_projections":[{"year":2026,"expected_kg":15000,"price_per_kg":0.5}],"notes":""},
        {"id":4,"name":"Tozeur Date Farm","location":"Tozeur","size_ha":4,"crop_type":"Date Palms","workers":[{"name":"Sadok Abdelli","daily_cost":45,"days":40}],"harvest_projections":[{"year":2026,"expected_kg":6000,"price_per_kg":3.5}],"notes":"Deglet Nour premium dates"},
        {"id":5,"name":"Ariana Tomato Fields","location":"Ariana","size_ha":2,"crop_type":"Tomatoes","workers":[{"name":"Walid Ferjani","daily_cost":32,"days":50}],"harvest_projections":[{"year":2026,"expected_kg":12000,"price_per_kg":0.4}],"notes":"Greenhouse growing"},
        {"id":6,"name":"Gafsa Pomegranate","location":"Gafsa","size_ha":3.5,"crop_type":"Pomegranate","workers":[{"name":"Tarek Ouali","daily_cost":36,"days":35}],"harvest_projections":[{"year":2026,"expected_kg":4500,"price_per_kg":2.2}],"notes":""},
        {"id":7,"name":"Gabes Pepper Farm","location":"Gabes","size_ha":1.5,"crop_type":"Peppers","workers":[{"name":"Noureddine Slim","daily_cost":28,"days":55}],"harvest_projections":[{"year":2026,"expected_kg":3000,"price_per_kg":1.1}],"notes":"Red and green peppers"},
        {"id":8,"name":"Monastir Vineyard","location":"Monastir","size_ha":6,"crop_type":"Grapes","workers":[{"name":"Riadh Ben Mrad","daily_cost":42,"days":65},{"name":"Imen Laabidi","daily_cost":38,"days":65}],"harvest_projections":[{"year":2026,"expected_kg":9000,"price_per_kg":1.5}],"notes":"Table grapes for export"},
        {"id":9,"name":"Beja Barley Fields","location":"Beja","size_ha":8,"crop_type":"Barley","workers":[{"name":"Fathi Zghal","daily_cost":38,"days":28}],"harvest_projections":[{"year":2026,"expected_kg":10000,"price_per_kg":0.45}],"notes":"Animal feed supply"},
        {"id":10,"name":"Jendouba Apple Orchard","location":"Jendouba","size_ha":4,"crop_type":"Apples","workers":[{"name":"Chokri Hamrouni","daily_cost":33,"days":70}],"harvest_projections":[{"year":2026,"expected_kg":7000,"price_per_kg":1.2}],"notes":"Golden and Red Delicious varieties"},
    ]

def main():
    data = load()
    if 'users' not in data:
        data['users'] = {}

    if 'demo' in data['users']:
        print("Demo user already exists. Delete it first or edit data.json manually.")
        return

    data['users']['demo'] = {
        "id": "demo",
        "password": "demo123",
        "full_name": "Demo User",
        "profile_pic": None,
        "totp_secret": None,
        "totp_enabled": False,
        "created_at": now(),
        "next_id": 11,
        "units": make_units(),
        "store_next_id": 11,
        "store_items": make_store(),
        "farm_next_id": 11,
        "farms": make_farms()
    }

    save(data)
    print("Demo account created.")
    print("  Username : demo")
    print("  Password : demo123")
    print("  Units    : 10 (8 occupied, 2 vacant)")
    print("  Store    : 10 items")
    print("  Farms    : 10 farms")

if __name__ == '__main__':
    main()
