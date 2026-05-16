import sqlite3
conn = sqlite3.connect('database.sqlite')
c = conn.cursor()
c.execute('SELECT name FROM sqlite_master WHERE type="table" AND name="payment_gateways"')
result = c.fetchone()
print('Table exists' if result else 'Table does not exist')
conn.close()