/**
 * Tookan service appointments and field workforce.
 *
 * Developer docs used for the request bodies:
 * - Create appointment task: job_pickup_datetime is the visit start and
 *   job_delivery_datetime is the time the visit should be finished.
 *   https://docs.jungleworks.com/tookan/tookan-create-task
 * - layout_type 0 is pickup-and-delivery, 1 is an appointment, 2 is a field
 *   (FOS) visit. https://docs.jungleworks.com/tookan/tookan-multiple-tasks
 *   The appointment section repeats the pickup-task sentence for has_pickup,
 *   has_delivery, and layout_type, so those three fixed pickup values are not
 *   sent for appointments. An appointment or field visit is has_pickup 0,
 *   has_delivery 0, with layout_type 1 or 2.
 * - Datetimes are "YYYY-MM-DD HH:mm:ss". IST is timezone -330.
 * - Teams: create_team, view_all_team_only. Agents: add_agent, get_all_fleets,
 *   view_fleet_profile, get_fleet_location. Assign: assign_task.
 *   https://docs.jungleworks.com/tookan/tookan-add-agent
 *   https://docs.jungleworks.com/tookan/tookan-get-all-agents
 *   https://docs.jungleworks.com/tookan/tookan-assign-agent-to-task
 *
 * Delivery tasks stay in commerce-logistics (layout_type 0, has_pickup 1,
 * has_delivery 1). This module does not build those bodies.
 */
const commerce = require('./commerce-logistics');

const TOOKAN_BASE = 'https://api.tookanapp.com/v2';
const IST_OFFSET = '-330';

const LAYOUT = { appointment: 1, fos: 2 };

const TRANSPORT = {
    1: 'Car',
    2: 'Motorcycle',
    3: 'Bicycle',
    4: 'Scooter',
    5: 'On foot',
    6: 'Truck'
};

/** Response status on get_all_fleets: 0 available, 1 offline, 2 busy. */
const AGENT_DUTY = { 0: 'Available', 1: 'Offline', 2: 'Busy' };

const JOB_STATUS = {
    0: { status: 'assigned', label: 'Partner assigned' },
    1: { status: 'started', label: 'Visit started' },
    2: { status: 'completed', label: 'Completed' },
    3: { status: 'failed', label: 'Unsuccessful' },
    4: { status: 'arrived', label: 'Partner arrived' },
    6: { status: 'booked', label: 'Waiting for a partner' },
    7: { status: 'assigned', label: 'Partner accepted' },
    8: { status: 'booked', label: 'Partner declined' },
    9: { status: 'cancelled', label: 'Cancelled' },
    10: { status: 'cancelled', label: 'Removed' }
};

const BOOKING_LABEL = {
    booked: 'Booked',
    assigned: 'Partner assigned',
    started: 'Visit started',
    arrived: 'Partner arrived',
    completed: 'Completed',
    failed: 'Unsuccessful',
    cancelled: 'Cancelled'
};

let transportOverride = null;

function setTransport(fn) {
    transportOverride = typeof fn === 'function' ? fn : null;
}

function fail(message, status) {
    const err = new Error(message || 'Request failed');
    err.status = status || 400;
    return err;
}

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function clip(value, max) {
    return String(value || '').trim().slice(0, max);
}

function numOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Wall clock the customer picked, kept as IST. No Date conversion, so UTC servers do not shift the visit. */
function wallClock(value) {
    const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return '';
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return '';
    const p = (n) => String(n).padStart(2, '0');
    return m[1] + '-' + p(month) + '-' + p(day) + ' ' + p(hour) + ':' + p(minute) + ':' + p(second);
}

function addWallMinutes(wall, minutes) {
    const start = wallClock(wall);
    const add = Number(minutes);
    if (!start || !Number.isFinite(add)) return '';
    const m = start.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    const next = new Date(utc + add * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return next.getUTCFullYear() + '-' + p(next.getUTCMonth() + 1) + '-' + p(next.getUTCDate()) + ' ' + p(next.getUTCHours()) + ':' + p(next.getUTCMinutes()) + ':' + p(next.getUTCSeconds());
}

function formatWall(wall) {
    const m = String(wall || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (!m) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let hour = Number(m[4]);
    const ap = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1] + ', ' + hour + ':' + m[5] + ' ' + ap + ' IST';
}

function istNowWall() {
    return commerce.tookanDateTime(Date.now());
}

function kindOf(value) {
    return String(value || '').toLowerCase() === 'fos' ? 'fos' : 'appointment';
}

function layoutFor(kind) {
    return kind === 'fos' ? LAYOUT.fos : LAYOUT.appointment;
}

/**
 * Appointment (layout 1) or field visit (layout 2).
 * job_pickup_datetime is the start. job_delivery_datetime is the finish-by time.
 */
function buildVisitBody(apiKey, visit) {
    const kind = kindOf(visit.kind);
    const start = wallClock(visit.start);
    const end = wallClock(visit.end) || addWallMinutes(start, visit.durationMin || 60);
    if (!start || !end) throw fail('Choose a valid visit time.');
    if (end <= start) throw fail('The visit end time has to be after the start.');
    const phone = digits(visit.phone);
    if (phone.length < 10 || phone.length > 15) throw fail('Enter a valid phone number.');
    const name = clip(visit.name, 80);
    const address = clip(visit.address, 300);
    if (name.length < 2) throw fail('Enter the customer name.');
    if (address.length < 8) throw fail('Enter the visit address.');
    const body = {
        api_key: apiKey,
        order_id: clip(visit.orderId, 40),
        job_description: clip(visit.description || (kind === 'fos' ? 'Field visit' : 'Service appointment'), 500),
        customer_username: name,
        customer_phone: phone,
        customer_address: address,
        job_pickup_datetime: start,
        job_delivery_datetime: end,
        has_pickup: 0,
        has_delivery: 0,
        layout_type: layoutFor(kind),
        tracking_link: 1,
        timezone: IST_OFFSET,
        notify: 1,
        geofence: visit.geofence ? 1 : 0,
        auto_assignment: 0
    };
    const email = clip(visit.email, 120);
    if (email) body.customer_email = email;
    const lat = numOrNull(visit.latitude);
    const lng = numOrNull(visit.longitude);
    if (lat != null && lng != null) {
        body.latitude = String(lat);
        body.longitude = String(lng);
    }
    const teamId = clip(visit.teamId, 20);
    if (teamId) body.team_id = teamId;
    const fleetId = clip(visit.fleetId, 20);
    if (fleetId) {
        body.fleet_id = fleetId;
        body.auto_assignment = 0;
    } else if (teamId && visit.autoAssign !== false) {
        body.auto_assignment = 1;
    }
    const tags = clip(visit.tags, 120);
    if (tags) body.tags = tags;
    const template = clip(visit.template, 80);
    if (template) body.custom_field_template = template.replace(/ /g, '_');
    const meta = Array.isArray(visit.meta) ? visit.meta.filter((row) => row && row.label).slice(0, 12) : [];
    if (meta.length) {
        body.meta_data = meta.map((row) => ({ label: clip(row.label, 60), data: clip(row.data, 200) }));
    }
    return body;
}

function buildTeamBody(apiKey, team) {
    const name = clip(team.teamName || team.name, 80);
    if (name.length < 2) throw fail('Enter a team name.');
    const battery = String(team.batteryUsage == null ? '1' : team.batteryUsage);
    if (battery !== '0' && battery !== '1' && battery !== '2') throw fail('Battery usage must be 0, 1, or 2.');
    const body = { api_key: apiKey, team_name: name, battery_usage: battery };
    const tags = clip(team.tags, 120);
    if (tags) body.tags = tags;
    return body;
}

function buildAgentBody(apiKey, agent) {
    const email = clip(agent.email, 120);
    const phone = digits(agent.phone);
    const username = clip(agent.username, 40);
    const first = clip(agent.firstName, 40);
    const last = clip(agent.lastName, 40);
    const teamId = clip(agent.teamId, 20);
    if (!email || email.indexOf('@') < 1) throw fail('Enter the agent email.');
    if (phone.length < 10) throw fail('Enter the agent phone.');
    if (username.length < 3) throw fail('Enter a username for the agent app.');
    if (!first) throw fail('Enter the agent first name.');
    if (!teamId) throw fail('Choose the team this agent belongs to.');
    const transport = String(agent.transportType == null ? 2 : agent.transportType);
    if (!TRANSPORT[transport]) throw fail('Choose a vehicle type.');
    const body = {
        api_key: apiKey,
        email: email,
        phone: phone,
        transport_type: transport,
        timezone: IST_OFFSET,
        team_id: teamId,
        username: username,
        first_name: first
    };
    if (last) body.last_name = last;
    const password = String(agent.password || '');
    if (password) body.password = password;
    const ruleId = numOrNull(agent.ruleId);
    if (ruleId != null) body.rule_id = ruleId;
    return body;
}

function buildAssignBody(apiKey, task) {
    const fleetId = numOrNull(task.fleetId);
    const jobId = numOrNull(task.jobId);
    if (fleetId == null) throw fail('Choose an agent.');
    if (jobId == null) throw fail('This visit has no Tookan task yet.');
    const body = {
        api_key: apiKey,
        fleet_id: fleetId,
        job_id: jobId,
        notify: task.notify === false ? 0 : 1,
        geofence: task.geofence ? 1 : 0
    };
    const teamId = numOrNull(task.teamId);
    if (teamId != null) body.team_id = teamId;
    if (task.jobStatus != null && task.jobStatus !== '') body.job_status = String(task.jobStatus);
    return body;
}

function buildCancelBody(apiKey, jobId) {
    const id = numOrNull(jobId);
    if (id == null) throw fail('This visit has no Tookan task yet.');
    return { api_key: apiKey, job_id: id, job_status: '9' };
}

function buildEditBody(apiKey, task) {
    const id = numOrNull(task.jobId);
    const start = wallClock(task.start);
    const end = wallClock(task.end);
    if (id == null) throw fail('This visit has no Tookan task yet.');
    if (!start || !end || end <= start) throw fail('Choose a valid visit time.');
    return {
        api_key: apiKey,
        job_id: id,
        job_pickup_datetime: start,
        job_delivery_datetime: end,
        timezone: IST_OFFSET
    };
}

function rowsOf(payload) {
    const data = payload && payload.data != null ? payload.data : payload;
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.teams)) return data.teams;
    if (Array.isArray(data.fleets)) return data.fleets;
    if (Array.isArray(data.data)) return data.data;
    return [];
}

function unwrap(res) {
    const data = (res && res.data) || {};
    const status = data.status;
    if (!res || res.statusCode >= 400 || status === 100 || status === 101 || status === 201 || status === 404) {
        throw fail(data.message || 'Tookan could not complete that request.', 502);
    }
    return data;
}

async function call(path, body) {
    if (transportOverride) return transportOverride(path, body);
    const res = await commerce.requestJson('POST', TOOKAN_BASE + path, { body: body, timeoutMs: 20000 });
    return unwrap(res);
}

function apiKeyOf(cfg) {
    const key = cfg && cfg.tookan && String(cfg.tookan.apiKey || '').trim();
    if (!key || !cfg.tookan.enabled) throw fail('Tookan is not connected. Add the API key in commerce settings.', 503);
    return key;
}

function taskIds(payload) {
    const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
    const jobId = data.job_id || data.appointment_job_id || (payload && typeof payload.data !== 'object' ? payload.data : '');
    return {
        jobId: jobId != null && jobId !== '' ? String(jobId) : '',
        trackingLink: data.tracking_link || data.pickup_tracking_link || ''
    };
}

async function createVisit(cfg, visit) {
    const body = buildVisitBody(apiKeyOf(cfg), visit);
    const data = await call('/create_task', body);
    return Object.assign(taskIds(data), { start: body.job_pickup_datetime, end: body.job_delivery_datetime, kind: kindOf(visit.kind) });
}

async function createTeam(cfg, team) {
    const body = buildTeamBody(apiKeyOf(cfg), team);
    const data = await call('/create_team', body);
    const node = data.data && typeof data.data === 'object' ? data.data : data;
    const teamId = node.team_id || node.id || '';
    return { teamId: teamId !== '' ? String(teamId) : '', name: body.team_name };
}

async function listTeams(cfg) {
    const key = apiKeyOf(cfg);
    let data;
    try {
        data = await call('/view_all_team_only', { api_key: key });
    } catch (err) {
        data = await call('/view_teams', { api_key: key });
    }
    return rowsOf(data).map((row) => ({
        teamId: String(row.team_id != null ? row.team_id : row.id || ''),
        name: row.team_name || row.name || 'Team',
        tags: row.tags || '',
        batteryUsage: row.battery_usage != null ? String(row.battery_usage) : ''
    })).filter((row) => row.teamId);
}

function publicAgent(row) {
    const duty = Number(row.status != null ? row.status : row.fleet_status);
    const transport = String(row.transport_type == null ? '' : row.transport_type);
    return {
        fleetId: String(row.fleet_id != null ? row.fleet_id : ''),
        name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || row.username || 'Agent',
        phone: row.phone || '',
        email: row.email || '',
        username: row.username || '',
        teamId: row.team_id != null ? String(row.team_id) : '',
        teamName: row.team_name || '',
        transport: TRANSPORT[transport] || '',
        duty: Number.isFinite(duty) ? duty : null,
        dutyLabel: AGENT_DUTY[duty] || 'Unknown',
        latitude: numOrNull(row.latitude),
        longitude: numOrNull(row.longitude)
    };
}

async function listAgents(cfg, filter) {
    const body = { api_key: apiKeyOf(cfg) };
    const spec = filter || {};
    if (spec.teamId) body.team_id = numOrNull(spec.teamId) || spec.teamId;
    if (spec.tags) body.tags = clip(spec.tags, 120);
    if (spec.availability === 'free') body.status = 0;
    if (spec.availability === 'busy') body.status = 1;
    if (spec.fleetType === 1 || spec.fleetType === 2) body.fleet_type = spec.fleetType;
    if (Array.isArray(spec.fleetIds) && spec.fleetIds.length) body.fleet_ids = spec.fleetIds.slice(0, 50);
    const data = await call('/get_all_fleets', body);
    return rowsOf(data).map(publicAgent).filter((row) => row.fleetId);
}

async function addAgent(cfg, agent) {
    const body = buildAgentBody(apiKeyOf(cfg), agent);
    const data = await call('/add_agent', body);
    const node = data.data && typeof data.data === 'object' ? data.data : data;
    const fleetId = node.fleet_id || node.id || '';
    return {
        fleetId: fleetId !== '' ? String(fleetId) : '',
        name: [body.first_name, body.last_name].filter(Boolean).join(' '),
        username: body.username,
        teamId: body.team_id
    };
}

async function agentProfile(cfg, fleetId) {
    const id = numOrNull(fleetId);
    if (id == null) throw fail('Choose an agent.');
    const data = await call('/view_fleet_profile', { api_key: apiKeyOf(cfg), fleet_id: id });
    const node = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : rowsOf(data)[0] || {};
    return publicAgent(Object.assign({ fleet_id: id }, node));
}

async function agentLocation(cfg, fleetId) {
    const id = clip(fleetId, 20);
    if (!id) throw fail('Choose an agent.');
    const data = await call('/get_fleet_location', { api_key: apiKeyOf(cfg), fleet_id: id });
    const node = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : rowsOf(data)[0] || data;
    return {
        fleetId: id,
        latitude: numOrNull(node.latitude != null ? node.latitude : node.lat),
        longitude: numOrNull(node.longitude != null ? node.longitude : node.lng)
    };
}

async function assignAgent(cfg, task) {
    const body = buildAssignBody(apiKeyOf(cfg), task);
    await call('/assign_task', body);
    return { fleetId: String(body.fleet_id), jobId: String(body.job_id) };
}

async function cancelTask(cfg, jobId) {
    const body = buildCancelBody(apiKeyOf(cfg), jobId);
    await call('/cancel_task', body);
    return { jobId: String(body.job_id) };
}

async function rescheduleTask(cfg, task) {
    const body = buildEditBody(apiKeyOf(cfg), task);
    await call('/edit_task', body);
    return { jobId: String(body.job_id), start: body.job_pickup_datetime, end: body.job_delivery_datetime };
}

async function readTask(cfg, jobId) {
    const id = numOrNull(jobId);
    if (id == null) throw fail('This visit has no Tookan task yet.');
    const data = await call('/get_job_details', { api_key: apiKeyOf(cfg), job_ids: [id], include_task_history: 0 });
    const node = rowsOf(data)[0] || {};
    const mapped = JOB_STATUS[Number(node.job_status)];
    return {
        jobId: String(node.job_id || id),
        jobStatus: node.job_status != null ? Number(node.job_status) : null,
        status: mapped ? mapped.status : '',
        statusLabel: mapped ? mapped.label : '',
        fleetId: node.fleet_id != null ? String(node.fleet_id) : '',
        fleetName: node.fleet_name || '',
        fleetPhone: node.fleet_phone || '',
        trackingLink: node.tracking_link || ''
    };
}

function bookingFromJob(taskStatus) {
    return JOB_STATUS[Number(taskStatus)] || null;
}

function phoneMatches(stored, given) {
    const a = digits(stored);
    const b = digits(given);
    if (a.length < 10 || b.length < 10) return false;
    return a.slice(-10) === b.slice(-10);
}

module.exports = {
    TOOKAN_BASE,
    IST_OFFSET,
    LAYOUT,
    TRANSPORT,
    AGENT_DUTY,
    JOB_STATUS,
    BOOKING_LABEL,
    setTransport,
    wallClock,
    addWallMinutes,
    formatWall,
    istNowWall,
    kindOf,
    buildVisitBody,
    buildTeamBody,
    buildAgentBody,
    buildAssignBody,
    buildCancelBody,
    buildEditBody,
    createVisit,
    createTeam,
    listTeams,
    listAgents,
    addAgent,
    agentProfile,
    agentLocation,
    assignAgent,
    cancelTask,
    rescheduleTask,
    readTask,
    bookingFromJob,
    phoneMatches,
    publicAgent,
    rowsOf
};
