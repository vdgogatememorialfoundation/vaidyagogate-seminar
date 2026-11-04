/**
 * WhatsApp Flows
 *
 * Encryption/decryption + single Meta Flow data-exchange endpoint.
 *
 * Business logic lives in:
 *
 *     lib/whatsapp-flow-app.js
 *
 * This file should NOT contain seminar registration business logic.
 */

const crypto = require('crypto');

const flowApp = require('./whatsapp-flow-app');

/* ------------------------------------------------------------
 * Encryption
 * ---------------------------------------------------------- */

function decryptRequest(body, privateKeyPem, passphrase) {
    const {
        encrypted_aes_key,
        encrypted_flow_data,
        initial_vector
    } = body || {};

    if (
        !encrypted_aes_key ||
        !encrypted_flow_data ||
        !initial_vector
    ) {
        return null;
    }

    const aesKey = crypto.privateDecrypt(
        {
            key: privateKeyPem,
            passphrase: passphrase || undefined,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        },
        Buffer.from(
            encrypted_aes_key,
            'base64'
        )
    );

    const flowData = Buffer.from(
        encrypted_flow_data,
        'base64'
    );

    const iv = Buffer.from(
        initial_vector,
        'base64'
    );

    const tagLen = 16;

    const cipherText =
        flowData.subarray(
            0,
            flowData.length - tagLen
        );

    const tag =
        flowData.subarray(
            flowData.length - tagLen
        );

    const decipher =
        crypto.createDecipheriv(
            'aes-128-gcm',
            aesKey,
            iv
        );

    decipher.setAuthTag(tag);

    const plain =
        Buffer.concat([
            decipher.update(cipherText),
            decipher.final()
        ]).toString('utf8');

    return {
        data: JSON.parse(plain),
        aesKey,
        iv
    };
}


/* ------------------------------------------------------------
 * Response encryption
 * ---------------------------------------------------------- */

function encryptResponse(
    obj,
    aesKey,
    iv
) {
    /*
     * Meta WhatsApp Flow requires the IV to be bit-flipped
     * for the response encryption.
     */
    const flipped = Buffer.from(
        iv.map(
            (byte) => (~byte) & 0xff
        )
    );

    const cipher =
        crypto.createCipheriv(
            'aes-128-gcm',
            aesKey,
            flipped
        );

    const encrypted =
        Buffer.concat([
            cipher.update(
                JSON.stringify(obj),
                'utf8'
            ),
            cipher.final(),
            cipher.getAuthTag()
        ]);

    return encrypted.toString(
        'base64'
    );
}


/* ------------------------------------------------------------
 * Database helpers
 * ---------------------------------------------------------- */

function q(
    db,
    sql,
    params = []
) {
    return new Promise(
        (resolve, reject) => {
            db.all(
                sql,
                params,
                (err, rows) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve(
                        rows || []
                    );
                }
            );
        }
    );
}


function one(
    db,
    sql,
    params = []
) {
    return new Promise(
        (resolve, reject) => {
            db.get(
                sql,
                params,
                (err, row) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve(
                        row || null
                    );
                }
            );
        }
    );
}


function run(
    db,
    sql,
    params = []
) {
    return new Promise(
        (resolve, reject) => {
            db.run(
                sql,
                params,
                function (err) {
                    if (err) {
                        return reject(err);
                    }

                    resolve({
                        lastID:
                            this &&
                            this.lastID,

                        changes:
                            this &&
                            this.changes
                    });
                }
            );
        }
    );
}


/* ------------------------------------------------------------
 * Dispatch
 * ---------------------------------------------------------- */

/**
 * Dispatch one decrypted WhatsApp Flow request.
 *
 * Expected Meta structure:
 *
 * {
 *   version,
 *   action,
 *   screen,
 *   data,
 *   flow_token
 * }
 */
async function dispatch(
    db,
    req,
    deps
) {
    /*
     * Meta health-check.
     */
    if (
        req &&
        req.action === 'ping'
    ) {
        return {
            data: {
                status: 'active'
            }
        };
    }

    req = req || {};

    const flowToken =
        String(
            req.flow_token || ''
        );

    const data =
        req.data || {};

    /*
     * Determine requested business action.
     */
    const actionName =
        String(
            data.action ||
            (
                req.action === 'INIT'
                    ? 'start'
                    : req.screen || ''
            )
        )
        .trim()
        .toLowerCase();


    /*
     * Get/create Flow session.
     */
    let session =
        await one(
            db,
            `
            SELECT *
            FROM wa_flow_sessions
            WHERE flow_token = ?
            `,
            [flowToken]
        );


    if (
        !session &&
        flowToken
    ) {
        await run(
            db,
            `
            INSERT INTO wa_flow_sessions (
                flow_token,
                last_screen,
                last_action,
                data_json
            )
            VALUES (?, ?, ?, '{}')
            `,
            [
                flowToken,
                req.screen || null,
                actionName
            ]
        );

        session =
            await one(
                db,
                `
                SELECT *
                FROM wa_flow_sessions
                WHERE flow_token = ?
                `,
                [flowToken]
            );
    }


    /*
     * Never rely on client-provided user_id.
     *
     * Session/database is the source of truth.
     */
    if (!session) {
        session = {
            flow_token: flowToken,
            phone: '',
            email: ''
        };
    }


    /*
     * Available actions come from the new application module.
     */
    const handler =
        flowApp.ACTIONS[
            actionName
        ];


    let output;


    if (!handler) {
        output = {
            error:
                'Unknown Flow action: ' +
                actionName,

            available:
                Object.keys(
                    flowApp.ACTIONS
                )
        };
    } else {
        try {
            output =
                await handler({
                    db,
                    data,
                    session,
                    deps,
                    req
                });
        } catch (error) {
            console.error(
                '[WhatsApp Flow]',
                actionName,
                error
            );

            output = {
                error:
                    error &&
                    error.message
                        ? error.message
                        : 'Flow action failed.'
            };
        }
    }


    /*
     * Refresh session after handler.
     *
     * Some actions update user_id,
     * seminar_id or registration_id.
     */
    if (flowToken) {
        const refreshed =
            await one(
                db,
                `
                SELECT *
                FROM wa_flow_sessions
                WHERE flow_token = ?
                `,
                [flowToken]
            );

        if (refreshed) {
            session = refreshed;
        }


        /*
         * Keep a limited audit trail of Flow data.
         *
         * Security-sensitive OTP codes/passwords are removed.
         */
        const safeData = {
            ...data
        };

        delete safeData.otp;
        delete safeData.login_otp;
        delete safeData.email_otp;
        delete safeData.phone_otp;
        delete safeData.password;

        /*
         * Verification tokens are also never persisted
         * in the generic session JSON.
         */
        delete safeData.email_verification_token;
        delete safeData.phone_verification_token;


        let previous = {};

        try {
            previous =
                JSON.parse(
                    session.data_json ||
                    '{}'
                ) || {};
        } catch (_) {
            previous = {};
        }


        const merged = {
            ...previous,
            ...safeData,
            _last_action:
                actionName,
            _last_result: output
        };


        await run(
            db,
            `
            UPDATE wa_flow_sessions
            SET
                last_screen = ?,
                last_action = ?,
                data_json = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE flow_token = ?
            `,
            [
                req.screen ||
                    session.last_screen ||
                    null,

                actionName,

                JSON.stringify(
                    merged
                ).slice(0, 20000),

                flowToken
            ]
        );
    }


    /*
     * Meta expects:
     *
     * {
     *   screen: "...",
     *   data: {...}
     * }
     *
     * For an error we keep the current screen unless
     * the Flow explicitly provides an error screen.
     */
    const nextScreen =
        (output && output.next_screen) ||
        data.next_screen ||
        req.next_screen ||
        req.screen ||
        'SUCCESS';


    return {
        screen:
            output &&
            output.error
                ? (
                    data.error_screen ||
                    nextScreen
                )
                : nextScreen,

        data: output || {}
    };
}


/* ------------------------------------------------------------
 * Endpoint factory
 * ---------------------------------------------------------- */

function makeEndpoint(
    db,
    deps,
    loadSettings
) {
    return async function flowEndpoint(
        req,
        res
    ) {
        try {
            const settings =
                typeof loadSettings === 'function'
                    ? await new Promise((resolve, reject) => {
                        loadSettings(db, (err, value) => {
                            if (err) return reject(err);
                            resolve(value || {});
                        });
                    })
                    : {};


            /*
             * Ping/health requests can be plain.
             */
            if (
                req &&
                req.body &&
                req.body.action === 'ping'
            ) {
                return res.json({
                    data: {
                        status: 'active'
                    }
                });
            }


            const body =
                req.body || {};


            /*
             * Local/plain JSON testing.
             *
             * Production Meta requests are encrypted.
             */
            if (
                !body.encrypted_aes_key
            ) {
                const plain =
                    await dispatch(
                        db,
                        body,
                        deps
                    );

                return res.json(
                    plain
                );
            }


            /*
             * Production encrypted request.
             */
            const privateKey =
                settings.flow_private_key;


            if (!privateKey) {
                console.error(
                    '[WhatsApp Flow] Private key not configured'
                );

                return res
                    .status(500)
                    .json({
                        error:
                            'WhatsApp Flow private key is not configured.'
                    });
            }


            const decrypted =
                decryptRequest(
                    body,
                    privateKey,
                    settings.flow_private_key_passphrase
                );


            if (!decrypted) {
                return res
                    .status(400)
                    .json({
                        error:
                            'Invalid encrypted Flow request.'
                    });
            }


            const result =
                await dispatch(
                    db,
                    decrypted.data,
                    deps
                );


            const encrypted =
                encryptResponse(
                    result,
                    decrypted.aesKey,
                    decrypted.iv
                );


            return res.send(
                encrypted
            );

        } catch (error) {
            console.error(
                '[WhatsApp Flow endpoint]',
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        error &&
                        error.message
                            ? error.message
                            : 'WhatsApp Flow endpoint error.'
                });
        }
    };
}


/* ------------------------------------------------------------
 * Exports
 * ---------------------------------------------------------- */

function actionNames() {
    return Object.keys(flowApp.ACTIONS || {});
}

module.exports = {
    makeEndpoint,
    dispatch,
    decryptRequest,
    encryptResponse,
    actionNames,
    ACTIONS:
        flowApp.ACTIONS
};
