/**
 * VGMF WhatsApp Flow Application
 *
 * Business logic for the WhatsApp registration journey.
 *
 * IMPORTANT:
 * - Existing website registration is NOT changed.
 * - Existing users table remains the master account database.
 * - Existing seminars table remains the master seminar database.
 * - Existing registrations/orders remain the master registration/payment records.
 * - OTP system is reused.
 * - Razorpay/order system is reused.
 */

const crypto = require('crypto');

const otp = require('./otp');
const notif = require('./notification-engine');
const authOtp = require('./auth-login-otp');
const audience = require('./whatsapp-audience');
const whatsappService = require('./whatsapp-service');
const seminarDt = require('./seminar-datetime');
const seminarDays = require('./seminar-days');

function q(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function one(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);

            resolve({
                lastID: this && this.lastID,
                changes: this && this.changes
            });
        });
    });
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
    const raw = String(value || '').replace(/\D/g, '');

    if (!raw) return '';

    if (raw.length >= 10) {
        return raw.slice(-10);
    }

    return raw;
}

function generatePassword() {
    return crypto.randomBytes(8).toString('base64url');
}

function generateAccountId(deps) {
    return String(deps.generateId()).replace(/\D/g, '').slice(0, 12);
}

async function seminarSummary(db, seminar) {
    const withDays = await new Promise((resolve) => {
        seminarDays.attachDaysToSeminarRows(
            db,
            [seminar],
            (err, output) => {
                resolve((output && output[0]) || seminar);
            }
        );
    });

    return {
        id: String(seminar.id),
        title: seminar.title,
        description: String(seminar.description || '').slice(0, 500),
        schedule: seminarDt.formatSeminarSchedule(
            withDays,
            withDays.days
        ),
        dates: seminarDt.seminarDateList(
            withDays,
            withDays.days
        ),
        price: Number(seminar.price) || 0,
        venue:
            seminar.location_text ||
            seminar.location_url ||
            '',
        days: (withDays.days || []).map((day) => ({
            id: String(day.id),
            title: day.title,
            date: day.day_date
        }))
    };
}

/* -----------------------------------------------------------
 * OTP DELIVERY
 * --------------------------------------------------------- */

async function sendOtp(db, {
    channel,
    destination,
    purpose,
    meta = {}
}) {
    const dest = otp.normalizeOtpDestination(
        channel,
        destination
    );

    if (!dest) {
        return {
            ok: false,
            error: 'Invalid destination'
        };
    }

    const count = await new Promise((resolve, reject) => {
        otp.countRecentSends(
            db,
            channel,
            dest,
            (err, value) => {
                if (err) return reject(err);
                resolve(Number(value || 0));
            }
        );
    });

    if (count >= 8) {
        return {
            ok: false,
            error: 'Too many OTP requests. Please try again later.'
        };
    }

    const code = otp.generateOtpDigits();

    await new Promise((resolve, reject) => {
        otp.saveOtp(
            db,
            {
                channel,
                destination: dest,
                purpose,
                meta
            },
            code,
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });

    let delivery;

    if (channel === 'phone') {
        const result = await notif.sendOtpMessages({
            phone: dest,
            code,
            db,
            purpose
        });

        delivery = result && result.whatsapp;
    } else {
        const result = await notif.sendOtpMessages({
            email: dest,
            code,
            db,
            purpose
        });

        delivery = result && result.email;
    }

    if (
        !delivery ||
        (!delivery.ok && !delivery.skipped)
    ) {
        return {
            ok: false,
            error:
                (delivery && delivery.error) ||
                'OTP could not be delivered.'
        };
    }

    return {
        ok: true,
        ttlMinutes: 10,
        channel
    };
}

async function verifyOtpCode(db, {
    channel,
    destination,
    purpose,
    code,
    meta = {},
    userId = null
}) {
    return new Promise((resolve, reject) => {
        otp.verifyOtp(
            db,
            {
                channel,
                destination,
                purpose,
                code,
                meta,
                userId
            },
            (err, result) => {
                if (err) return reject(err);
                resolve(result || {});
            }
        );
    });
}

async function validateVerificationToken(
    db,
    token,
    expectedPurpose,
    expectedChannel
) {
    if (!token) return false;

    const result = await new Promise((resolve, reject) => {
        otp.consumeVerificationToken(
            db,
            token,
            (err, value) => {
                if (err) return reject(err);
                resolve(value || {});
            },
            true
        );
    });

    if (!result.ok) return false;

    if (
        expectedPurpose &&
        result.purpose !== expectedPurpose
    ) {
        return false;
    }

    if (
        expectedChannel &&
        result.channel !== expectedChannel
    ) {
        return false;
    }

    return true;
}

async function consumeVerificationToken(db, token) {
    if (!token) return;

    await new Promise((resolve, reject) => {
        otp.consumeVerificationToken(
            db,
            token,
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

/* -----------------------------------------------------------
 * USER LOOKUP
 * --------------------------------------------------------- */

async function findUser(db, email, phone) {
    const em = normalizeEmail(email);
    const ph = normalizePhone(phone);

    let user = null;

    if (em) {
        user = await one(
            db,
            `
            SELECT
                id,
                user_id_string,
                first_name,
                middle_name,
                last_name,
                email,
                phone,
                whatsapp,
                password,
                email_verified
            FROM users
            WHERE LOWER(TRIM(email)) = ?
            ORDER BY id ASC
            LIMIT 1
            `,
            [em]
        );
    }

    if (!user && ph) {
        user = await one(
            db,
            `
            SELECT
                id,
                user_id_string,
                first_name,
                middle_name,
                last_name,
                email,
                phone,
                whatsapp,
                password,
                email_verified
            FROM users
            WHERE
                REPLACE(
                    REPLACE(
                        REPLACE(TRIM(phone), ' ', ''),
                        '-',
                        ''
                    ),
                    '+',
                    ''
                ) = ?
                OR
                REPLACE(
                    REPLACE(
                        REPLACE(TRIM(whatsapp), ' ', ''),
                        '-',
                        ''
                    ),
                    '+',
                    ''
                ) = ?
            ORDER BY id ASC
            LIMIT 1
            `,
            [ph, ph]
        );
    }

    return user;
}

/* -----------------------------------------------------------
 * ACTIONS
 * --------------------------------------------------------- */

const ACTIONS = {

    /*
     * Initial Flow screen.
     */
    async start({ db }) {
        return {
            ok: true,
            message:
                'Welcome to Vaidya Gogate Memorial Foundation seminar registration.'
        };
    },

    /*
     * User enters phone/email.
     *
     * We ONLY identify the account here.
     * Authentication happens through OTP.
     */
    async identify_user({ db, data }) {
        const email = normalizeEmail(data.email);
        const phone = normalizePhone(data.phone);

        if (!email && !phone) {
            return {
                error: 'Please enter your email or mobile number.'
            };
        }

        const user = await findUser(
            db,
            email,
            phone
        );

        if (user) {
            const otpResult = await new Promise((resolve, reject) => {
                authOtp.sendLoginOtpsForUser(
                    db,
                    user,
                    (err, response) => {
                        if (err) return reject(err);
                        resolve(response);
                    }
                );
            });

            if (!otpResult || !otpResult.ok) {
                return {
                    error:
                        (otpResult && otpResult.error) ||
                        'OTP could not be sent. Please try again.'
                };
            }

            return {
                found: true,
                existing_account: true,
                user_id: String(user.id),
                account_id: user.user_id_string,
                first_name: user.first_name || '',
                last_name: user.last_name || '',
                email: user.email || '',
                phone: user.phone || '',
                otp_sent: true,
                ttl_minutes: otpResult.ttlMinutes || 10,
                next_screen: 'LOGIN_OTP'
            };
        }

        return {
            found: false,
            existing_account: false,
            email,
            phone,
            next_screen: 'NEW_ACCOUNT'
        };
    },

    /*
     * EXISTING ACCOUNT
     *
     * Send login OTP to email + WhatsApp/mobile.
     */
    async send_login_otp({ db, data }) {
        const email = normalizeEmail(data.email);
        const phone = normalizePhone(data.phone);

        const user = await findUser(
            db,
            email,
            phone
        );

        if (!user) {
            return {
                error:
                    'Account not found. Please use new account registration.'
            };
        }

        const result =
            await new Promise((resolve, reject) => {
                authOtp.sendLoginOtpsForUser(
                    db,
                    user,
                    (err, response) => {
                        if (err) return reject(err);
                        resolve(response);
                    }
                );
            });

        return {
            ok: !!result.ok,
            ttl_minutes: result.ttlMinutes || 10,
            message: result.ok
                ? 'OTP sent to your registered email and mobile.'
                : result.error || 'OTP could not be sent.'
        };
    },

    /*
     * Verify existing-account OTP.
     *
     * Successful verification authenticates the Flow session.
     */
    async verify_login_otp({
        db,
        data,
        session
    }) {
        const code = String(
            data.otp ||
            data.login_otp ||
            ''
        ).trim();

        if (!code) {
            return {
                error: 'Please enter the OTP.'
            };
        }

        const email = normalizeEmail(
            data.email ||
            session.email
        );

        const phone = normalizePhone(
            data.phone ||
            session.phone
        );

        const user = await findUser(
            db,
            email,
            phone
        );

        if (!user) {
            return {
                error: 'Account not found.'
            };
        }

        /*
         * Try the channel supplied by Flow.
         * If no channel supplied, try phone first and email second.
         */
        let verified = false;

        const channels = [];

        if (data.otp_channel === 'phone') {
            channels.push({
                channel: 'phone',
                destination: phone
            });
        } else if (data.otp_channel === 'email') {
            channels.push({
                channel: 'email',
                destination: email
            });
        } else {
            if (phone) {
                channels.push({
                    channel: 'phone',
                    destination: phone
                });
            }

            if (email) {
                channels.push({
                    channel: 'email',
                    destination: email
                });
            }
        }

        for (const item of channels) {
            if (!item.destination) continue;

            const result = await verifyOtpCode(
                db,
                {
                    channel: item.channel,
                    destination: item.destination,
                    purpose: 'login',
                    code,
                    meta: {
                        userId: user.id
                    },
                    userId: user.id
                }
            );

            if (result && result.ok) {
                verified = true;
                break;
            }
        }

        if (!verified) {
            return {
                error: 'Invalid or expired OTP.'
            };
        }

        await run(
            db,
            `
            UPDATE wa_flow_sessions
            SET user_id = ?
            WHERE flow_token = ?
            `,
            [
                user.id,
                session.flow_token || ''
            ]
        );

        return {
            ok: true,
            authenticated: true,
            account_id: user.user_id_string,
            user_id: String(user.id),
            first_name: user.first_name || '',
            message: 'Login successful.'
        };
    },

    /*
     * NEW ACCOUNT
     *
     * Check that email/phone are not already registered.
     */
    async check_new_account({ db, data }) {
        const email = normalizeEmail(data.email);
        const phone = normalizePhone(data.phone);

        if (!email || !phone) {
            return {
                error:
                    'Email and mobile number are required.'
            };
        }

        const existing = await findUser(
            db,
            email,
            phone
        );

        if (existing) {
            return {
                exists: true,
                account_id:
                    existing.user_id_string,
                message:
                    'An account already exists. Please use OTP login.'
            };
        }

        return {
            exists: false,
            ok: true
        };
    },

    /*
     * Send NEW ACCOUNT email OTP.
     */
    async send_signup_email_otp({
        db,
        data
    }) {
        const email = normalizeEmail(data.email);

        if (!email) {
            return {
                error: 'Email is required.'
            };
        }

        const existing = await findUser(
            db,
            email,
            ''
        );

        if (existing) {
            return {
                error:
                    'An account already exists with this email.'
            };
        }

        return await sendOtp(db, {
            channel: 'email',
            destination: email,
            purpose: 'signup',
            meta: {
                source: 'whatsapp_flow'
            }
        });
    },

    /*
     * Verify NEW ACCOUNT email OTP.
     */
    async verify_signup_email_otp({
        db,
        data
    }) {
        const email = normalizeEmail(data.email);
        const code = String(
            data.otp ||
            data.email_otp ||
            ''
        ).trim();

        if (!email || !code) {
            return {
                error:
                    'Email and OTP are required.'
            };
        }

        const result = await verifyOtpCode(
            db,
            {
                channel: 'email',
                destination: email,
                purpose: 'signup',
                code,
                meta: {
                    source: 'whatsapp_flow'
                }
            }
        );

        if (!result || !result.ok) {
            return {
                error:
                    result.error ||
                    'Invalid or expired OTP.'
            };
        }

        return {
            ok: true,
            email_verified: true,
            email_verification_token:
                result.token
        };
    },

    /*
     * Send NEW ACCOUNT mobile OTP.
     */
    async send_signup_phone_otp({
        db,
        data
    }) {
        const phone = normalizePhone(data.phone);

        if (!phone) {
            return {
                error:
                    'Mobile number is required.'
            };
        }

        const existing = await findUser(
            db,
            '',
            phone
        );

        if (existing) {
            return {
                error:
                    'An account already exists with this mobile number.'
            };
        }

        return await sendOtp(db, {
            channel: 'phone',
            destination: phone,
            purpose: 'signup',
            meta: {
                source: 'whatsapp_flow'
            }
        });
    },

    /*
     * Verify NEW ACCOUNT mobile OTP.
     */
    async verify_signup_phone_otp({
        db,
        data
    }) {
        const phone = normalizePhone(data.phone);
        const code = String(
            data.otp ||
            data.phone_otp ||
            ''
        ).trim();

        if (!phone || !code) {
            return {
                error:
                    'Mobile number and OTP are required.'
            };
        }

        const result = await verifyOtpCode(
            db,
            {
                channel: 'phone',
                destination: phone,
                purpose: 'signup',
                code,
                meta: {
                    source: 'whatsapp_flow'
                }
            }
        );

        if (!result || !result.ok) {
            return {
                error:
                    result.error ||
                    'Invalid or expired OTP.'
            };
        }

        return {
            ok: true,
            phone_verified: true,
            phone_verification_token:
                result.token
        };
    },

    /*
     * CREATE ACCOUNT
     *
     * Requires BOTH verification tokens.
     */
    async create_account({
        db,
        data,
        session,
        deps
    }) {
        const first = String(
            data.first_name || ''
        ).trim();

        const middle = String(
            data.middle_name || ''
        ).trim();

        const last = String(
            data.last_name || ''
        ).trim();

        const email = normalizeEmail(
            data.email
        );

        const phone = normalizePhone(
            data.phone
        );

        const emailToken = String(
            data.email_verification_token || ''
        );

        const phoneToken = String(
            data.phone_verification_token || ''
        );

        if (!first || !last) {
            return {
                error:
                    'First name and last name are required.'
            };
        }

        if (!email || !phone) {
            return {
                error:
                    'Email and mobile number are required.'
            };
        }

        /*
         * Verify both tokens without consuming first.
         */
        const emailValid =
            await validateVerificationToken(
                db,
                emailToken,
                'signup:email',
                'email'
            );

        const phoneValid =
            await validateVerificationToken(
                db,
                phoneToken,
                'signup:phone',
                'phone'
            );

        if (!emailValid) {
            return {
                error:
                    'Email verification has expired. Please verify again.'
            };
        }

        if (!phoneValid) {
            return {
                error:
                    'Mobile verification has expired. Please verify again.'
            };
        }

        /*
         * Final duplicate check immediately before INSERT.
         */
        const existing = await findUser(
            db,
            email,
            phone
        );

        if (existing) {
            return {
                error:
                    'An account already exists. Please use OTP login.',
                account_id:
                    existing.user_id_string
            };
        }

        let accountId = '';

        /*
         * Generate unique 12-digit account number.
         */
        for (let i = 0; i < 10; i++) {
            const candidate =
                generateAccountId(deps);

            const duplicate = await one(
                db,
                `
                SELECT id
                FROM users
                WHERE user_id_string = ?
                LIMIT 1
                `,
                [candidate]
            );

            if (!duplicate) {
                accountId = candidate;
                break;
            }
        }

        if (!accountId) {
            return {
                error:
                    'Could not generate a unique account ID. Please try again.'
            };
        }

        const password =
            generatePassword();

        const insert = await run(
            db,
            `
            INSERT INTO users (
                user_id_string,
                first_name,
                middle_name,
                last_name,
                email,
                phone,
                whatsapp,
                password,
                role,
                user_role,
                email_verified,
                profile_complete
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                'doctor',
                'doctor',
                1,
                0
            )
            `,
            [
                accountId,
                first,
                middle || null,
                last,
                email,
                phone,
                phone,
                password
            ]
        );

        let userId = insert.lastID;

        if (!userId) {
            const created = await one(
                db,
                `
                SELECT id, user_id_string
                FROM users
                WHERE user_id_string = ?
                LIMIT 1
                `,
                [accountId]
            );

            if (!created) {
                return {
                    error:
                        'Account creation could not be confirmed.'
                };
            }

            userId = created.id;
        }

        /*
         * Consume verification tokens only after successful
         * account creation.
         */
        await consumeVerificationToken(
            db,
            emailToken
        );

        await consumeVerificationToken(
            db,
            phoneToken
        );

        /*
         * Authenticate this Flow session.
         */
        await run(
            db,
            `
            UPDATE wa_flow_sessions
            SET user_id = ?
            WHERE flow_token = ?
            `,
            [
                userId,
                session.flow_token || ''
            ]
        );

        /*
         * Existing notification engine sends account-created
         * email using the ACCOUNT_CREATED template.
         */
        notif.notify(
            db,
            'ACCOUNT_CREATED',
            {
                userId,
                vars: {
                    temporary_password: password
                },
                immediate: true
            },
            () => {}
        );

        return {
            ok: true,
            account_created: true,
            authenticated: true,
            user_id: String(userId),
            account_id: accountId,
            message:
                'Your account has been created successfully. Login details have been sent to your email.'
        };
    },

    /*
     * LIST ACTIVE SEMINARS
     */
    async list_seminars({ db }) {
        const rows = await q(
            db,
            `
            SELECT *
            FROM seminars
            WHERE IFNULL(is_active, 1) = 1
              AND (
                    registration_end IS NULL
                    OR registration_end >= ?
                  )
            ORDER BY event_date ASC
            LIMIT 20
            `,
            [new Date().toISOString()]
        );

        const seminars = [];

        for (const seminar of rows) {
            seminars.push(
                await seminarSummary(
                    db,
                    seminar
                )
            );
        }

        return {
            seminars: seminars.map(
                (s) => ({
                    id: s.id,
                    title: s.title,
                    description:
                        s.schedule +
                        (
                            s.price
                                ? ` · ₹${s.price}`
                                : ''
                        )
                })
            ),
            count: seminars.length
        };
    },

    /*
     * SELECT SEMINAR
     */
    async select_seminar({
        db,
        data,
        session
    }) {
        const seminarId =
            parseInt(
                data.seminar_id,
                10
            ) || 0;

        const seminar = await one(
            db,
            `
            SELECT *
            FROM seminars
            WHERE id = ?
            `,
            [seminarId]
        );

        if (!seminar) {
            return {
                error:
                    'Seminar not found.'
            };
        }

        await run(
            db,
            `
            UPDATE wa_flow_sessions
            SET seminar_id = ?
            WHERE flow_token = ?
            `,
            [
                seminarId,
                session.flow_token || ''
            ]
        );

        const summary = await seminarSummary(
            db,
            seminar
        );

        return {
            ok: true,
            seminar: summary,
            title: summary.title || '',
            schedule: summary.schedule || '',
            venue: summary.venue || '',
            price: String(summary.price ?? '')
        };
    },

    /*
     * TERMS & CONDITIONS
     */
    async accept_terms({
        data
    }) {
        const accepted =
            data.terms_accepted === true ||
            data.terms_accepted === 'true' ||
            data.terms_accepted === '1' ||
            data.accept_terms === true ||
            data.accept_terms === 'true';

        if (!accepted) {
            return {
                error:
                    'Please accept the Terms & Conditions to continue.'
            };
        }

        return {
            ok: true,
            terms_accepted: true
        };
    },

    /*
     * RETURN SEMINAR-SPECIFIC FORM.
     */
    async registration_form({
        db,
        data
    }) {
        const seminarId =
            parseInt(
                data.seminar_id,
                10
            ) || 0;

        const seminar = await one(
            db,
            `
            SELECT
                id,
                title,
                price,
                custom_fields_schema,
                registration_form_json
            FROM seminars
            WHERE id = ?
            `,
            [seminarId]
        );

        if (!seminar) {
            return {
                error:
                    'Seminar not found.'
            };
        }

        let fields = [];

        try {
            const raw =
                seminar.registration_form_json ||
                seminar.custom_fields_schema;

            const parsed =
                raw
                    ? JSON.parse(raw)
                    : null;

            const list =
                Array.isArray(parsed)
                    ? parsed
                    : (
                        parsed &&
                        Array.isArray(
                            parsed.fields
                        )
                            ? parsed.fields
                            : []
                    );

            fields = list.map(
                (field) => ({
                    name:
                        field.name ||
                        field.key ||
                        field.id,

                    label:
                        field.label ||
                        field.name ||
                        field.key,

                    type:
                        field.type ||
                        'text',

                    required:
                        !!field.required
                })
            );
        } catch (_) {
            fields = [];
        }

        return {
            ok: true,
            seminar_id:
                String(seminar.id),
            title: seminar.title,
            price:
                Number(seminar.price) || 0,
            fields
        };
    },

    /*
     * SUBMIT REGISTRATION
     *
     * IMPORTANT:
     * user_id comes from authenticated Flow session,
     * NOT from user-provided Flow data.
     */
    async submit_registration({
        db,
        data,
        session
    }) {
        const userId =
            parseInt(
                session.user_id,
                10
            ) || 0;

        if (!userId) {
            return {
                error:
                    'Please authenticate your account first.'
            };
        }

        const seminarId =
            parseInt(
                data.seminar_id ||
                session.seminar_id,
                10
            ) || 0;

        if (!seminarId) {
            return {
                error:
                    'Please select a seminar.'
            };
        }

        const seminar = await one(
            db,
            `
            SELECT *
            FROM seminars
            WHERE id = ?
            `,
            [seminarId]
        );

        if (!seminar) {
            return {
                error:
                    'Seminar not found.'
            };
        }

        const accepted =
            data.terms_accepted === true ||
            data.terms_accepted === 'true' ||
            data.terms_accepted === '1';

        if (!accepted) {
            return {
                error:
                    'Please accept the Terms & Conditions.'
            };
        }

        const existing = await one(
            db,
            `
            SELECT
                id,
                application_no,
                status
            FROM registrations
            WHERE user_id = ?
              AND seminar_id = ?
              AND status NOT IN (
                    'cancelled',
                    'refunded',
                    'rejected'
                  )
            ORDER BY id DESC
            LIMIT 1
            `,
            [
                userId,
                seminarId
            ]
        );

        if (existing) {
            return {
                ok: true,
                already_registered: true,
                registration_id:
                    String(existing.id),
                application_no:
                    existing.application_no,
                status:
                    existing.status
            };
        }

        const applicationNo =
            String(
                data.application_no ||
                ''
            ).replace(/\D/g, '') ||
            String(
                Math.floor(
                    100000000000 +
                    Math.random() *
                    900000000000
                )
            );

        const autoApprove =
            Number(
                seminar.auto_confirm_registration
            ) === 1;

        const formData = {};

        /*
         * Do not store authentication/security fields
         * inside form_data.
         */
        const excluded = new Set([
            'action',
            'flow_token',
            'seminar_id',
            'terms_accepted',
            'email',
            'phone',
            'password',
            'otp',
            'email_otp',
            'phone_otp',
            'login_otp',
            'email_verification_token',
            'phone_verification_token'
        ]);

        Object.keys(data || {}).forEach(
            (key) => {
                if (!excluded.has(key)) {
                    formData[key] =
                        data[key];
                }
            }
        );

        formData.source =
            'whatsapp_flow';

        const inserted = await run(
            db,
            `
            INSERT INTO registrations (
                user_id,
                seminar_id,
                application_no,
                status,
                form_data,
                registration_source
            )
            VALUES (?, ?, ?, ?, ?, 'whatsapp_flow')
            `,
            [
                userId,
                seminarId,
                applicationNo,
                autoApprove
                    ? 'approved_pending_payment'
                    : 'pending_approval',
                JSON.stringify(formData)
            ]
        );

        const registrationId =
            inserted.lastID ||
            (
                await one(
                    db,
                    `
                    SELECT id
                    FROM registrations
                    WHERE application_no = ?
                    LIMIT 1
                    `,
                    [applicationNo]
                )
            ).id;

        await run(
            db,
            `
            UPDATE wa_flow_sessions
            SET
                user_id = ?,
                registration_id = ?,
                seminar_id = ?
            WHERE flow_token = ?
            `,
            [
                userId,
                registrationId,
                seminarId,
                session.flow_token || ''
            ]
        );

        return {
            ok: true,
            registration_id:
                String(registrationId),
            application_no:
                applicationNo,
            status:
                autoApprove
                    ? 'approved_pending_payment'
                    : 'pending_approval',
            amount:
                Number(seminar.price) || 0
        };
    },

    /*
     * CREATE / REUSE PAYMENT ORDER
     */
    async create_order({
        db,
        data,
        session,
        deps
    }) {
        const registrationId =
            parseInt(
                data.registration_id ||
                session.registration_id,
                10
            ) || 0;

        if (!registrationId) {
            return {
                error:
                    'Registration not found in this WhatsApp session.'
            };
        }

        const registration =
            await one(
                db,
                `
                SELECT
                    r.id,
                    r.application_no,
                    r.status,
                    r.user_id,
                    r.seminar_id,
                    u.user_id_string,
                    u.phone,
                    u.email,
                    s.title,
                    s.price
                FROM registrations r
                JOIN users u
                  ON u.id = r.user_id
                JOIN seminars s
                  ON s.id = r.seminar_id
                WHERE r.id = ?
                `,
                [registrationId]
            );

        if (!registration) {
            return {
                error:
                    'Registration not found.'
            };
        }

        /*
         * Check whether this registration is already paid.
         */
        const paid = await one(
            db,
            `
            SELECT id
            FROM orders
            WHERE registration_id = ?
              AND status = 'success'
            LIMIT 1
            `,
            [registrationId]
        );

        if (paid) {
            return {
                ok: true,
                already_paid: true,
                registration_id:
                    String(registrationId),
                application_no:
                    registration.application_no,
                amount:
                    Number(registration.price) || 0
            };
        }

        /*
         * Create or reuse the existing pending order.
         */
        const order =
            await new Promise(
                (resolve, reject) => {
                    deps.getOrCreatePendingOrder(
                        registrationId,
                        Number(
                            registration.price
                        ) || undefined,
                        (err, result) => {
                            if (err) {
                                return reject(
                                    err
                                );
                            }

                            resolve(
                                result
                            );
                        }
                    );
                }
            );

        const orderId =
            order &&
            order.order_id_string
                ? String(
                    order.order_id_string
                )
                : '';

        const amount =
            Number(
                order &&
                order.amount
            ) ||
            Number(
                registration.price
            ) ||
            0;

        /*
         * Send the official WhatsApp
         * Review & Pay order_details message.
         *
         * The actual payment amount comes from
         * the existing registration/order system.
         */
        let paymentMessage = null;

        if (registration.phone && amount > 0) {
            paymentMessage =
                await whatsappService
                    .sendWhatsAppOrderDetails(
                        registration.phone,
                        {
                            referenceId:
                                orderId ||
                                String(
                                    registrationId
                                ),

                            orderId,

                            registrationId:
                                String(
                                    registrationId
                                ),

                            applicationNo:
                                registration.application_no,

                            amount,

                            itemName:
                                registration.title ||
                                'Seminar Registration'
                        }
                    );
        }

        /*
         * Keep the existing website payment link
         * available as a fallback/reference.
         */
        return {
            ok: true,

            registration_id:
                String(registrationId),

            order_id:
                orderId,

            amount,

            application_no:
                registration.application_no,

            payment_message_sent:
                Boolean(
                    paymentMessage &&
                    paymentMessage.ok
                ),

            payment_message_error:
                paymentMessage &&
                !paymentMessage.ok
                    ? paymentMessage.error ||
                      'Unable to send WhatsApp payment message.'
                    : null,

            payment_link:
                audience.paymentLink(
                    registration
                )
        };
    },

    /*
     * PAYMENT / REGISTRATION STATUS
     */
    async payment_status({
        db,
        data,
        session
    }) {
        const registrationId =
            parseInt(
                data.registration_id ||
                session.registration_id,
                10
            ) || 0;

        const row = await one(
            db,
            `
            SELECT
                r.id,
                r.application_no,
                r.status,
                s.title,
                s.price,
                EXISTS (
                    SELECT 1
                    FROM orders o
                    WHERE o.registration_id = r.id
                      AND o.status = 'success'
                ) AS paid
            FROM registrations r
            JOIN seminars s
              ON s.id = r.seminar_id
            WHERE r.id = ?
            LIMIT 1
            `,
            [registrationId]
        );

        if (!row) {
            return {
                error:
                    'Registration not found.'
            };
        }

        const paid = !!Number(row.paid);

        return {
            registration_id:
                String(row.id),

            application_no:
                row.application_no,

            seminar:
                row.title,

            amount:
                Number(row.price) || 0,

            status:
                String(
                    row.status || ''
                ).replace(/_/g, ' '),

            paid,

            next_screen:
                paid
                    ? 'ETICKET_STATUS'
                    : 'PAYMENT_WAIT'
        };
    },

    /*
     * E-TICKET
     */
    async eticket_status({
        db,
        data,
        session
    }) {
        const registrationId =
            parseInt(
                data.registration_id || session.registration_id,
                10
            ) || 0;

        const userId =
            parseInt(
                session.user_id,
                10
            ) || 0;

        if (!registrationId) {
            return {
                error: 'Registration ID is required.'
            };
        }

        if (!userId) {
            return {
                error: 'Please authenticate your account first.'
            };
        }

        // Verify that this registration belongs to the authenticated user.
        const registration = await one(
            db,
            `
            SELECT
                r.id,
                r.user_id,
                r.application_no,
                r.status,
                s.title AS seminar_title
            FROM registrations r
            JOIN seminars s
              ON s.id = r.seminar_id
            WHERE r.id = ?
              AND r.user_id = ?
            LIMIT 1
            `,
            [registrationId, userId]
        );

        if (!registration) {
            return {
                error: 'Registration not found for this account.'
            };
        }

        const rows = await q(
            db,
            `
            SELECT
                t.id,
                t.ticket_id_string,
                t.is_scanned,
                t.user_id,
                sd.title AS day_title,
                sd.day_date
            FROM tickets t
            JOIN orders o
              ON o.id = t.order_id
            LEFT JOIN seminar_days sd
              ON sd.id = t.day_id
            WHERE o.registration_id = ?
              AND IFNULL(t.is_valid, 1) = 1
            ORDER BY
                sd.sort_order,
                t.id
            `,
            [registrationId]
        );

        return {
            ok: true,

            issued:
                rows.length > 0,

            registration_id:
                String(registration.id),

            application_no:
                registration.application_no || '',

            seminar:
                registration.seminar_title || '',

            registration_status:
                registration.status || '',

            tickets:
                rows.map(
                    (ticket) => ({
                        ticket_id:
                            ticket.ticket_id_string || '',

                        day:
                            ticket.day_title || '',

                        date:
                            ticket.day_date || '',

                        scanned:
                            !!Number(
                                ticket.is_scanned
                            ),

                        link:
                            ticket.ticket_id_string
                                ? audience.ticketLink(
                                      ticket.ticket_id_string,
                                      ticket.user_id || userId
                                  )
                                : ''
                    })
                )
        };
    },

    async certificate_status({
        db,
        data,
        session
    }) {
        const registrationId =
            parseInt(
                data.registration_id || session.registration_id,
                10
            ) || 0;

        if (!registrationId) {
            return {
                error: 'Registration ID is required.'
            };
        }

        const userId =
            parseInt(
                session.user_id,
                10
            ) || 0;

        if (!userId) {
            return {
                error: 'Please authenticate your account first.'
            };
        }

        const row = await one(
            db,
            `
            SELECT
                r.id AS registration_id,
                r.user_id,
                r.application_no,
                r.status AS registration_status,

                s.id AS seminar_id,
                s.title AS seminar_title,
                s.event_date,

                EXISTS (
                    SELECT 1
                    FROM orders o
                    WHERE o.registration_id = r.id
                      AND LOWER(TRIM(o.status)) = 'success'
                ) AS paid,

                EXISTS (
                    SELECT 1
                    FROM tickets t
                    JOIN orders ot
                      ON ot.id = t.order_id
                    WHERE ot.registration_id = r.id
                      AND IFNULL(t.is_valid, 1) = 1
                      AND IFNULL(t.is_scanned, 0) = 1
                ) AS attended,

                uc.id AS certificate_id,
                COALESCE(uc.enabled, 0) AS certificate_enabled,
                COALESCE(uc.scan_verified, 0) AS scan_verified,
                uc.template_id

            FROM registrations r

            JOIN seminars s
              ON s.id = r.seminar_id

            LEFT JOIN user_certificates uc
              ON uc.user_id = r.user_id
             AND uc.seminar_id = r.seminar_id

            WHERE r.id = ?
              AND r.user_id = ?

            LIMIT 1
            `,
            [registrationId, userId]
        );

        if (!row) {
            return {
                error: 'Registration not found for this account.'
            };
        }

        const paid =
            !!Number(row.paid);

        const attended =
            !!Number(row.attended);

        const scanVerified =
            !!Number(row.scan_verified);

        const certificateEnabled =
            !!Number(row.certificate_enabled);

        let status = 'certificate_pending';
        let message = 'Certificate is not yet available.';

        if (!paid) {
            status = 'payment_pending';
            message = 'Payment for this registration is not completed.';
        } else if (!attended) {
            status = 'attendance_pending';
            message = 'Certificate will be processed after your event attendance is recorded.';
        } else if (!row.certificate_id) {
            status = 'certificate_pending';
            message = 'Your attendance is recorded. Certificate processing is pending.';
        } else if (certificateEnabled) {
            status = 'issued';
            message = 'Your certificate is available.';
        } else if (scanVerified) {
            status = 'awaiting_approval';
            message = 'Your attendance has been verified. Certificate is awaiting approval/release.';
        } else {
            status = 'certificate_pending';
            message = 'Certificate processing is in progress.';
        }

        const certificatePdfApi =
            certificateEnabled && row.certificate_id
                ? `/api/doctor/certificate-pdf-data/${userId}?uc=${encodeURIComponent(row.certificate_id)}`
                : '';

        return {
            ok: true,

            registration_id:
                String(row.registration_id),

            application_no:
                row.application_no || '',

            seminar_id:
                String(row.seminar_id),

            seminar:
                row.seminar_title || '',

            event_date:
                row.event_date || '',

            registration_status:
                row.registration_status || '',

            paid,

            attended,

            certificate_id:
                row.certificate_id
                    ? String(row.certificate_id)
                    : '',

            scan_verified:
                scanVerified,

            certificate_enabled:
                certificateEnabled,

            status,

            message,

            certificate_pdf_api:
                certificatePdfApi
        };
    },

    /*
     * Simple health test.
     */
    async ping() {
        return {
            status: 'active'
        };
    }
};

module.exports = {
    ACTIONS
};
