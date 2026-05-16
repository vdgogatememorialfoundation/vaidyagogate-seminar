import sqlite3, json
conn = sqlite3.connect('database.sqlite')
c = conn.cursor()
c.execute("PRAGMA table_info('registrations')")
rows = c.fetchall()
print(json.dumps(rows, indent=2))
conn.close()
