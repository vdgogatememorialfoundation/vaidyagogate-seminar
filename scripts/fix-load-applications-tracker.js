const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('            // Render Vertical Tracker');
const end = s.indexOf('        });\n    } catch (err) {\n        console.error(err);\n    }\n}\n\nlet currentlyViewedApp');
if (start < 0 || end < 0) {
    console.error('markers', start, end);
    process.exit(1);
}
const rep = `            trackerContainer.innerHTML += renderSeminarApplicationTrackerCard(a);
        });
    } catch (err) {
        console.error(err);
    }
}

let currentlyViewedApp`;
s = s.slice(0, start) + rep + s.slice(end + '        });\n    } catch (err) {\n        console.error(err);\n    }\n}\n\nlet currentlyViewedApp'.length);
fs.writeFileSync(p, s);
console.log('ok');
