/**
 * Appointment and field-force request bodies, plus the booking desk against a fake Tookan.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const field = require('../lib/tookan-field');
const routes = require('../lib/tookan-field-routes');
const commerce = require('../lib/commerce-logistics');

function ahead(days, time) {
    return field.addWallMinutes(field.istNowWall(), days * 24 * 60).slice(0, 10) + ' ' + time;
}

function checkBodies() {
    const shifted = field.wallClock('2026-11-15T15:30');
    assert.strictEqual(shifted, '2026-11-15 15:30:00');
    assert.strictEqual(field.addWallMinutes('2026-11-15 23:30:00', 60), '2026-11-16 00:30:00');
    assert.strictEqual(field.formatWall('2026-11-15 15:30:00'), '15 Nov 2026, 3:30 PM IST');

    const appointment = field.buildVisitBody('secret-key', {
        kind: 'appointment',
        start: '2026-11-15 10:00:00',
        durationMin: 60,
        name: 'Asha Rao',
        phone: '+91 98765 43210',
        email: 'asha@example.com',
        address: '12 Link Road, Pune',
        orderId: 'SV100',
        teamId: '7',
        tags: 'clinic'
    });
    assert.strictEqual(appointment.layout_type, 1);
    assert.strictEqual(appointment.has_pickup, 0);
    assert.strictEqual(appointment.has_delivery, 0);
    assert.strictEqual(appointment.timezone, '-330');
    assert.strictEqual(appointment.job_pickup_datetime, '2026-11-15 10:00:00');
    assert.strictEqual(appointment.job_delivery_datetime, '2026-11-15 11:00:00');
    assert.strictEqual(appointment.auto_assignment, 1);
    assert.strictEqual(appointment.team_id, '7');
    assert.strictEqual(appointment.tracking_link, 1);
    assert.strictEqual(appointment.customer_phone, '919876543210');
    assert.ok(!appointment.fleet_id);

    const visit = field.buildVisitBody('secret-key', {
        kind: 'fos',
        start: '2026-11-15 10:00:00',
        end: '2026-11-15 12:00:00',
        name: 'Asha Rao',
        phone: '9876543210',
        address: '12 Link Road, Pune',
        orderId: 'SV101',
        fleetId: '42',
        latitude: 18.52,
        longitude: 73.85
    });
    assert.strictEqual(visit.layout_type, 2);
    assert.strictEqual(visit.has_pickup, 0);
    assert.strictEqual(visit.has_delivery, 0);
    assert.strictEqual(visit.auto_assignment, 0);
    assert.strictEqual(visit.fleet_id, '42');
    assert.strictEqual(visit.latitude, '18.52');

    const team = field.buildTeamBody('secret-key', { teamName: 'Clinic rounds', batteryUsage: 1, tags: 'field' });
    assert.strictEqual(team.team_name, 'Clinic rounds');
    assert.strictEqual(team.battery_usage, '1');

    const agent = field.buildAgentBody('secret-key', {
        email: 'neha@example.com',
        phone: '9999900000',
        username: 'neha',
        firstName: 'Neha',
        lastName: 'Kulkarni',
        teamId: '7',
        transportType: 2,
        password: 'temp-pass'
    });
    assert.strictEqual(agent.transport_type, '2');
    assert.strictEqual(agent.timezone, '-330');
    assert.strictEqual(agent.team_id, '7');
    assert.strictEqual(agent.password, 'temp-pass');

    const assign = field.buildAssignBody('secret-key', { fleetId: 42, jobId: 88001, teamId: 7, jobStatus: '0' });
    assert.deepStrictEqual(Object.keys(assign).sort(), ['api_key', 'fleet_id', 'geofence', 'job_id', 'job_status', 'notify', 'team_id']);
    assert.strictEqual(assign.job_status, '0');
    const cancel = field.buildCancelBody('secret-key', 88001);
    assert.strictEqual(cancel.job_status, '9');
    const edited = field.buildEditBody('secret-key', { jobId: 88001, start: '2026-11-16 09:00:00', end: '2026-11-16 10:00:00' });
    assert.strictEqual(edited.job_pickup_datetime, '2026-11-16 09:00:00');
    assert.strictEqual(edited.timezone, '-330');

    const delivery = commerce.buildTookanTaskBody(
        { tookan: { apiKey: 'k' }, storePhone: '9876543210', storeAddress: 'Store road', storeName: 'Desk' },
        { orderCode: 'O1', buyerPhone: '9876543210', buyerName: 'Asha', deliveryAddress: 'Customer road 12' },
        'hyperlocal'
    );
    assert.strictEqual(delivery.layout_type, 0);
    assert.strictEqual(delivery.has_pickup, 1);
    assert.strictEqual(delivery.has_delivery, 1);
    assert.strictEqual(field.phoneMatches('9876543210', '+91 98765 43210'), true);
    assert.strictEqual(field.phoneMatches('9876543210', '1111111111'), false);
    assert.strictEqual(field.bookingFromJob(2).status, 'completed');
    assert.strictEqual(field.bookingFromJob(4).status, 'arrived');
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(port, method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: urlPath,
            method: method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = {};
                try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function main() {
    checkBodies();
    const calls = [];
    let jobSeq = 88001;
    field.setTransport(async (path, body) => {
        const copy = Object.assign({}, body);
        calls.push({ path: path, body: copy });
        if (path === '/create_task') {
            const jobId = jobSeq++;
            return { status: 200, data: { job_id: jobId, tracking_link: 'https://track.example/v/' + jobId } };
        }
        if (path === '/view_all_team_only') return { status: 200, data: [{ team_id: 7, team_name: 'Clinic', tags: 'field' }] };
        if (path === '/create_team') return { status: 200, data: { team_id: 8 } };
        if (path === '/get_all_fleets') return { status: 200, data: [{ fleet_id: 42, name: 'Neha', phone: '9999900000', status: 0, team_id: 7, transport_type: 2, latitude: 19.1, longitude: 72.8 }] };
        if (path === '/add_agent') return { status: 200, data: { fleet_id: 43 } };
        if (path === '/assign_task') return { status: 200, data: {} };
        if (path === '/cancel_task') return { status: 200, data: {} };
        if (path === '/edit_task') return { status: 200, data: {} };
        if (path === '/get_job_details') {
            const jobId = body.job_ids && body.job_ids[0];
            return { status: 200, data: [{ job_id: jobId, job_status: 1, fleet_id: 42, fleet_name: 'Neha', fleet_phone: '9999900000', tracking_link: 'https://track.example/v/' + jobId }] };
        }
        if (path === '/get_fleet_location') return { status: 200, data: { latitude: 19.2, longitude: 72.9 } };
        if (path === '/view_fleet_profile') return { status: 200, data: { fleet_id: 42, first_name: 'Neha', status: 2, phone: '9999900000' } };
        throw new Error('unexpected ' + path);
    });

    const db = await new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(handle)));
    });
    const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], (err) => (err ? reject(err) : resolve())));
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, user_role TEXT, admin_modules TEXT, staff_modules TEXT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, is_disabled INTEGER, is_banned INTEGER)`);
    await run(`INSERT INTO users (id, role, first_name, is_disabled, is_banned) VALUES (1, 'admin', 'Desk', 0, 0)`);
    await run(`INSERT INTO users (id, role, user_role, first_name, is_disabled, is_banned) VALUES (2, 'doctor', 'doctor', 'Doc', 0, 0)`);
    await run(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT)`);
    await run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [commerce.CONFIG_KEY, JSON.stringify({ tookan: { enabled: true, apiKey: 'secret-key' } })]);

    routes.resetSchemaForTests();
    const app = express();
    app.use(express.json());
    routes.registerTookanFieldRoutes(app, db);
    require('../lib/commerce-routes').registerCommerceRoutes(app, db, {});
    const server = await listen(app);
    const port = server.address().port;
    const admin = { 'x-acting-user-id': '1' };
    try {
        const services = await request(port, 'GET', '/api/public/field/services');
        assert.strictEqual(services.status, 200);
        assert.ok(services.body.services.length >= 3);
        const home = services.body.services.find((row) => row.name === 'Home consultation');
        assert.strictEqual(home.kind, 'appointment');

        const when = ahead(2, '10:00:00');
        const booked = await request(port, 'POST', '/api/public/field/bookings', {
            serviceId: home.id,
            start: when,
            name: 'Asha Rao',
            phone: '9876543210',
            address: '12 Link Road, Pune',
            notes: 'Gate 2',
            clientToken: 'browser-1'
        });
        assert.strictEqual(booked.status, 200, JSON.stringify(booked.body));
        assert.strictEqual(booked.body.booking.kind, 'appointment');
        assert.ok(/^SV\d{8}$/.test(booked.body.booking.code));
        assert.ok(booked.body.booking.startLabel.indexOf('IST') > 0);
        assert.ok(!booked.body.booking.api_key && !JSON.stringify(booked.body).includes('secret-key'));
        const created = calls.find((row) => row.path === '/create_task');
        assert.ok(created);
        assert.strictEqual(created.body.layout_type, 1);
        assert.strictEqual(created.body.has_pickup, 0);
        assert.strictEqual(created.body.has_delivery, 0);
        assert.strictEqual(created.body.timezone, '-330');
        assert.strictEqual(created.body.order_id, booked.body.booking.code);

        const again = await request(port, 'POST', '/api/public/field/bookings', { serviceId: home.id, start: when, name: 'Asha Rao', phone: '9876543210', address: '12 Link Road, Pune', clientToken: 'browser-1' });
        assert.strictEqual(again.body.booking.code, booked.body.booking.code);
        assert.strictEqual(calls.filter((row) => row.path === '/create_task').length, 1);

        const hidden = await request(port, 'POST', '/api/public/field/bookings/lookup', { code: booked.body.booking.code, phone: '1111111111' });
        assert.strictEqual(hidden.status, 404);
        const found = await request(port, 'POST', '/api/public/field/bookings/lookup', { code: booked.body.booking.code, phone: '+91 98765 43210' });
        assert.strictEqual(found.status, 200);
        assert.strictEqual(found.body.booking.status, 'started');
        assert.strictEqual(found.body.booking.partner, 'Neha');
        assert.strictEqual(found.body.booking.partnerLatitude, 19.2);

        const denied = await request(port, 'GET', '/api/admin/field/teams', null, { 'x-acting-user-id': '2' });
        assert.strictEqual(denied.status, 403);
        const teams = await request(port, 'GET', '/api/admin/field/teams', null, admin);
        assert.strictEqual(teams.body.teams[0].name, 'Clinic');
        const made = await request(port, 'POST', '/api/admin/field/teams', { teamName: 'Evening round', batteryUsage: '2', tags: 'field' }, admin);
        assert.strictEqual(made.status, 200);
        assert.strictEqual(calls.filter((row) => row.path === '/create_team')[0].body.battery_usage, '2');

        const agents = await request(port, 'GET', '/api/admin/field/agents?availability=free', null, admin);
        assert.strictEqual(agents.body.agents[0].dutyLabel, 'Available');
        assert.strictEqual(calls.filter((row) => row.path === '/get_all_fleets').pop().body.status, 0);
        const added = await request(port, 'POST', '/api/admin/field/agents', {
            firstName: 'Neha', phone: '9999900000', email: 'neha@example.com', username: 'neha', teamId: '7', transportType: 2, password: 'temp-pass'
        }, admin);
        assert.strictEqual(added.status, 200);
        assert.ok(!JSON.stringify(added.body).includes('temp-pass'));
        assert.strictEqual(calls.filter((row) => row.path === '/add_agent').pop().body.password, 'temp-pass');

        const list = await request(port, 'GET', '/api/admin/field/bookings', null, admin);
        const id = list.body.bookings[0].id;
        const assigned = await request(port, 'POST', '/api/admin/field/bookings/' + id + '/assign', { fleetId: 42, teamId: 7, fleetName: 'Neha' }, admin);
        assert.strictEqual(assigned.body.booking.status, 'assigned');
        assert.strictEqual(calls.filter((row) => row.path === '/assign_task').pop().body.fleet_id, 42);

        const moved = await request(port, 'POST', '/api/admin/field/bookings/' + id + '/reschedule', { start: ahead(3, '16:00:00') }, admin);
        assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
        assert.ok(moved.body.booking.start.indexOf('16:00:00') > 0);
        assert.strictEqual(calls.filter((row) => row.path === '/edit_task').pop().body.timezone, '-330');

        const fos = await request(port, 'POST', '/api/admin/field/bookings', {
            kind: 'fos',
            serviceName: 'Field follow-up',
            start: ahead(4, '11:00:00'),
            durationMin: 90,
            name: 'Ravi Shah',
            phone: '9988776655',
            address: '44 Hill Road, Mumbai',
            fleetId: '42',
            teamId: '7'
        }, admin);
        assert.strictEqual(fos.status, 200, JSON.stringify(fos.body));
        assert.strictEqual(fos.body.booking.kind, 'fos');
        const fosCall = calls.filter((row) => row.path === '/create_task').pop();
        assert.strictEqual(fosCall.body.layout_type, 2);
        assert.strictEqual(fosCall.body.has_pickup, 0);
        assert.strictEqual(fosCall.body.has_delivery, 0);
        assert.strictEqual(fosCall.body.fleet_id, '42');

        const hook = await request(port, 'POST', '/api/public/tookan/webhook', { job_id: 88001, job_status: 2, job_type: 2, fleet_name: 'Neha' });
        assert.strictEqual(hook.status, 200, JSON.stringify(hook.body));
        assert.strictEqual(hook.body.matched, true);
        const after = await request(port, 'GET', '/api/admin/field/bookings', null, admin);
        const updated = after.body.bookings.find((row) => row.code === booked.body.booking.code);
        assert.strictEqual(updated.status, 'completed');

        const cancelled = await request(port, 'POST', '/api/public/field/bookings/cancel', { code: fos.body.booking.code, phone: '9988776655' });
        assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.strictEqual(cancelled.body.booking.status, 'cancelled');
        assert.strictEqual(calls.filter((row) => row.path === '/cancel_task').pop().body.job_status, '9');

        const past = await request(port, 'POST', '/api/public/field/bookings', {
            serviceId: home.id,
            start: '2020-01-01 10:00:00',
            name: 'Asha Rao',
            phone: '9876543210',
            address: '12 Link Road, Pune'
        });
        assert.strictEqual(past.status, 400);
        console.log('tookan field ok');
    } finally {
        field.setTransport(null);
        server.close();
        db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
