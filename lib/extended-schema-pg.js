/**
 * Auxiliary tables required beyond core seminar flow — idempotent on Neon.
 */
let lastAuxDdlErrors = [];

const AUX_TABLE_DDL = [
    {
        name: 'global_settings',
        sql: `CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`
    },
    {
        name: 'file_blobs',
        sql: `CREATE TABLE IF NOT EXISTS file_blobs (
            storage_key TEXT PRIMARY KEY,
            mime_type TEXT,
            original_name TEXT,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'payment_gateways',
        sql: `CREATE TABLE IF NOT EXISTS payment_gateways (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE,
            is_active BOOLEAN DEFAULT FALSE,
            config TEXT
        )`
    },
    {
        name: 'case_programs',
        sql: `CREATE TABLE IF NOT EXISTS case_programs (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            seminar_id INTEGER,
            registration_start TIMESTAMPTZ,
            registration_end TIMESTAMPTZ,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            form_config_json TEXT,
            max_presentations_per_user INTEGER DEFAULT 2,
            max_total_submissions INTEGER,
            max_files_per_submission INTEGER DEFAULT 5,
            max_file_size_mb INTEGER DEFAULT 50,
            enabled_categories TEXT,
            instructions TEXT,
            portal_year INTEGER,
            judge_criteria_json TEXT
        )`
    },
    {
        name: 'case_submissions',
        sql: `CREATE TABLE IF NOT EXISTS case_submissions (
            id SERIAL PRIMARY KEY,
            case_program_id INTEGER,
            user_id INTEGER,
            seminar_id INTEGER,
            title TEXT,
            category TEXT,
            status TEXT DEFAULT 'submitted',
            application_no TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            plagiarism_zero INTEGER DEFAULT 0
        )`
    },
    {
        name: 'case_judge_assignments',
        sql: `CREATE TABLE IF NOT EXISTS case_judge_assignments (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(submission_id, judge_user_id)
        )`
    },
    {
        name: 'case_judge_scores',
        sql: `CREATE TABLE IF NOT EXISTS case_judge_scores (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            criteria_json TEXT,
            total_score REAL,
            remarks TEXT,
            submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            is_locked INTEGER DEFAULT 0,
            UNIQUE(submission_id, judge_user_id)
        )`
    },
    {
        name: 'judge_communication_log',
        sql: `CREATE TABLE IF NOT EXISTS judge_communication_log (
            id SERIAL PRIMARY KEY,
            judge_user_id INTEGER NOT NULL,
            submission_id INTEGER,
            registration_id INTEGER,
            participant_user_id INTEGER,
            channel TEXT NOT NULL DEFAULT 'email',
            subject TEXT,
            body_preview TEXT,
            to_address TEXT,
            from_display TEXT,
            status TEXT,
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'case_participant_messages',
        sql: `CREATE TABLE IF NOT EXISTS case_participant_messages (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            direction TEXT NOT NULL,
            author_user_id INTEGER NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'case_files',
        sql: `CREATE TABLE IF NOT EXISTS case_files (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            original_name TEXT,
            status TEXT DEFAULT 'pending',
            rejection_reason TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'seminar_feedback',
        sql: `CREATE TABLE IF NOT EXISTS seminar_feedback (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            seminar_id INTEGER,
            registration_id INTEGER,
            rating INTEGER DEFAULT 5,
            content_quality INTEGER DEFAULT 5,
            speaker_quality INTEGER DEFAULT 5,
            organization_quality INTEGER DEFAULT 5,
            overall_experience TEXT,
            suggestions TEXT,
            would_attend_again INTEGER DEFAULT 1,
            answers_json TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'supplemental_payments',
        sql: `CREATE TABLE IF NOT EXISTS supplemental_payments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER,
            registration_id INTEGER,
            title TEXT NOT NULL,
            description TEXT,
            amount NUMERIC NOT NULL,
            status TEXT DEFAULT 'pending',
            order_id INTEGER,
            created_by_admin INTEGER,
            admin_note TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            paid_at TIMESTAMPTZ
        )`
    },
    {
        name: 'ticket_scan_events',
        sql: `CREATE TABLE IF NOT EXISTS ticket_scan_events (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER NOT NULL,
            ticket_db_id INTEGER,
            ticket_id_string TEXT,
            application_no TEXT,
            doctor_user_id INTEGER,
            doctor_name TEXT,
            outcome TEXT NOT NULL,
            message TEXT,
            scanned_by INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'admin_mail_threads',
        sql: `CREATE TABLE IF NOT EXISTS admin_mail_threads (
            id SERIAL PRIMARY KEY,
            subject TEXT NOT NULL,
            participant_email TEXT NOT NULL,
            participant_user_id INTEGER,
            participant_name TEXT,
            created_by INTEGER,
            seminar_id INTEGER,
            status TEXT DEFAULT 'open',
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'admin_mail_thread_messages',
        sql: `CREATE TABLE IF NOT EXISTS admin_mail_thread_messages (
            id SERIAL PRIMARY KEY,
            thread_id INTEGER NOT NULL,
            direction TEXT NOT NULL,
            author_user_id INTEGER,
            body TEXT NOT NULL,
            source TEXT DEFAULT 'portal',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'venue_id_captures',
        sql: `CREATE TABLE IF NOT EXISTS venue_id_captures (
            id SERIAL PRIMARY KEY,
            scan_event_id INTEGER,
            seminar_id INTEGER NOT NULL,
            ticket_db_id INTEGER,
            ticket_id_string TEXT,
            registration_id INTEGER,
            doctor_user_id INTEGER,
            scanner_user_id INTEGER,
            id_photo_path TEXT NOT NULL,
            captured_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'case_judge_marking_reminder_log',
        sql: `CREATE TABLE IF NOT EXISTS case_judge_marking_reminder_log (
            judge_user_id INTEGER NOT NULL,
            submission_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (judge_user_id, submission_id, sent_date)
        )`
    },
    {
        name: 'case_status_log',
        sql: `CREATE TABLE IF NOT EXISTS case_status_log (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            step_key TEXT NOT NULL,
            label TEXT,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'registration_status_log',
        sql: `CREATE TABLE IF NOT EXISTS registration_status_log (
            id SERIAL PRIMARY KEY,
            registration_id INTEGER NOT NULL,
            step_key TEXT NOT NULL,
            label TEXT,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'application_edits',
        sql: `CREATE TABLE IF NOT EXISTS application_edits (
            id SERIAL PRIMARY KEY,
            application_id INTEGER,
            edited_by_user_id INTEGER,
            changes TEXT,
            edited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (application_id) REFERENCES registrations(id)
        )`
    },
    {
        name: 'doctor_profile',
        sql: `CREATE TABLE IF NOT EXISTS doctor_profile (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE,
            specialization TEXT,
            registration_no TEXT,
            qualifications TEXT,
            experience_years INTEGER,
            hospital_name TEXT,
            contact_number TEXT,
            bio TEXT,
            profile_photo_path TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'abstracts',
        sql: `CREATE TABLE IF NOT EXISTS abstracts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            topic TEXT NOT NULL,
            video_path TEXT,
            ppt_path TEXT,
            status TEXT DEFAULT 'Under Review',
            rejection_reason TEXT,
            marks INTEGER DEFAULT 0,
            judge_remarks TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'support_tickets',
        sql: `CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY,
            ticket_id TEXT UNIQUE,
            tracking_id TEXT UNIQUE,
            user_id INTEGER NOT NULL,
            category TEXT,
            subject TEXT NOT NULL,
            description TEXT,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'open',
            attachment_path TEXT,
            assigned_to_admin INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            admin_response TEXT
        )`
    },
    {
        name: 'ticket_messages',
        sql: `CREATE TABLE IF NOT EXISTS ticket_messages (
            id SERIAL PRIMARY KEY,
            ticket_id TEXT NOT NULL,
            sender_id INTEGER NOT NULL,
            sender_type TEXT,
            message TEXT NOT NULL,
            attachment_path TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'cancellation_requests',
        sql: `CREATE TABLE IF NOT EXISTS cancellation_requests (
            id SERIAL PRIMARY KEY,
            registration_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            refund_percent INTEGER DEFAULT 0,
            refund_amount REAL DEFAULT 0,
            refund_status TEXT DEFAULT 'none',
            provider_refund_id TEXT,
            admin_notes TEXT,
            reviewed_by INTEGER,
            reviewed_at TIMESTAMPTZ,
            requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            policy_snapshot TEXT
        )`
    },
    {
        name: 'contact_inquiries',
        sql: `CREATE TABLE IF NOT EXISTS contact_inquiries (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT,
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'new',
            admin_notes TEXT,
            replied_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ
        )`
    },
    {
        name: 'certificate_templates',
        sql: `CREATE TABLE IF NOT EXISTS certificate_templates (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER,
            file_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            uploaded_by INTEGER,
            is_active INTEGER DEFAULT 1,
            cert_type TEXT DEFAULT 'participant',
            config_json TEXT,
            signature_left_path TEXT,
            signature_right_path TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'user_certificates',
        sql: `CREATE TABLE IF NOT EXISTS user_certificates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER NOT NULL,
            ticket_id INTEGER,
            registration_id INTEGER,
            display_name TEXT NOT NULL,
            template_id INTEGER,
            enabled INTEGER DEFAULT 0,
            scan_verified INTEGER DEFAULT 0,
            scan_time TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, seminar_id)
        )`
    },
    {
        name: 'user_activity_logs',
        sql: `CREATE TABLE IF NOT EXISTS user_activity_logs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            user_role TEXT,
            action TEXT NOT NULL,
            resource_type TEXT,
            resource_id TEXT,
            seminar_id INTEGER,
            ip TEXT,
            user_agent TEXT,
            meta TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'email_verify_tokens',
        sql: `CREATE TABLE IF NOT EXISTS email_verify_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'otp_codes',
        sql: `CREATE TABLE IF NOT EXISTS otp_codes (
            id SERIAL PRIMARY KEY,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            purpose TEXT NOT NULL,
            meta TEXT,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'otp_verification_tokens',
        sql: `CREATE TABLE IF NOT EXISTS otp_verification_tokens (
            id SERIAL PRIMARY KEY,
            token_hash TEXT NOT NULL,
            purpose TEXT NOT NULL,
            channel TEXT NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'password_reset_tokens',
        sql: `CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'notices',
        sql: `CREATE TABLE IF NOT EXISTS notices (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT,
            pdf_path TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'event_schedules',
        sql: `CREATE TABLE IF NOT EXISTS event_schedules (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            seminar_id INTEGER,
            start_time TIMESTAMPTZ NOT NULL,
            end_time TIMESTAMPTZ NOT NULL,
            location TEXT,
            speaker_name TEXT,
            speaker_bio TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'notification_queue',
        sql: `CREATE TABLE IF NOT EXISTS notification_queue (
            id SERIAL PRIMARY KEY,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            template_key TEXT,
            payload TEXT,
            scheduled_at TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'notification_templates',
        sql: `CREATE TABLE IF NOT EXISTS notification_templates (
            id SERIAL PRIMARY KEY,
            event_key TEXT NOT NULL,
            seminar_id INTEGER,
            enabled INTEGER DEFAULT 1,
            channel TEXT DEFAULT 'both',
            email_subject TEXT,
            email_html TEXT,
            whatsapp_template_name TEXT,
            whatsapp_body TEXT,
            version INTEGER DEFAULT 1,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(event_key, seminar_id)
        )`
    },
    {
        name: 'notification_logs',
        sql: `CREATE TABLE IF NOT EXISTS notification_logs (
            id SERIAL PRIMARY KEY,
            event_key TEXT,
            channel TEXT,
            destination TEXT,
            user_id INTEGER,
            seminar_id INTEGER,
            status TEXT,
            subject TEXT,
            body_preview TEXT,
            error TEXT,
            provider_message_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'refunds',
        sql: `CREATE TABLE IF NOT EXISTS refunds (
            id SERIAL PRIMARY KEY,
            order_id INTEGER,
            registration_id INTEGER,
            amount REAL,
            percent INTEGER,
            gateway TEXT,
            provider_refund_id TEXT,
            status TEXT,
            raw_response TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'registration_reminder_log',
        sql: `CREATE TABLE IF NOT EXISTS registration_reminder_log (
            registration_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (registration_id, sent_date)
        )`
    },
    {
        name: 'pending_registration_reminder_log',
        sql: `CREATE TABLE IF NOT EXISTS pending_registration_reminder_log (
            registration_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (registration_id, sent_date)
        )`
    },
    {
        name: 'registration_overrides',
        sql: `CREATE TABLE IF NOT EXISTS registration_overrides (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER NOT NULL,
            enabled INTEGER DEFAULT 1,
            register_until TIMESTAMPTZ,
            note TEXT,
            created_by INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, seminar_id)
        )`
    },
    {
        name: 'seminar_volunteers',
        sql: `CREATE TABLE IF NOT EXISTS seminar_volunteers (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            approved_by INTEGER,
            approved_at TIMESTAMPTZ,
            volunteer_ticket_id_string TEXT,
            notes TEXT,
            duties TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(seminar_id, user_id)
        )`
    },
    {
        name: 'volunteer_certificates',
        sql: `CREATE TABLE IF NOT EXISTS volunteer_certificates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER NOT NULL,
            registration_id INTEGER,
            display_name TEXT NOT NULL,
            template_id INTEGER,
            enabled INTEGER DEFAULT 0,
            scan_verified INTEGER DEFAULT 0,
            scan_time TIMESTAMPTZ,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, seminar_id)
        )`
    },
    {
        name: 'homepage_banners',
        sql: `CREATE TABLE IF NOT EXISTS homepage_banners (
            id SERIAL PRIMARY KEY,
            title TEXT,
            subtitle TEXT,
            description TEXT,
            image_path TEXT NOT NULL,
            cta_text TEXT,
            cta_url TEXT,
            sort_order INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'user_roles',
        sql: `CREATE TABLE IF NOT EXISTS user_roles (
            id SERIAL PRIMARY KEY,
            role_name TEXT UNIQUE,
            description TEXT,
            permissions TEXT
        )`
    },
    {
        name: 'interactive_session_registrations',
        sql: `CREATE TABLE IF NOT EXISTS interactive_session_registrations (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            registration_id INTEGER NOT NULL,
            seminar_id INTEGER,
            form_data TEXT,
            ticket_id_string TEXT UNIQUE,
            status TEXT DEFAULT 'registered',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'live_chat_sessions',
        sql: `CREATE TABLE IF NOT EXISTS live_chat_sessions (
            id SERIAL PRIMARY KEY,
            session_id TEXT UNIQUE,
            user_id INTEGER,
            admin_id INTEGER,
            status TEXT DEFAULT 'active',
            query TEXT,
            resolution TEXT,
            rating INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMPTZ
        )`
    },
    {
        name: 'live_chat_messages',
        sql: `CREATE TABLE IF NOT EXISTS live_chat_messages (
            id SERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            sender_id INTEGER NOT NULL,
            sender_type TEXT,
            message TEXT NOT NULL,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'support_messages',
        sql: `CREATE TABLE IF NOT EXISTS support_messages (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER NOT NULL,
            sender TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'case_pending_uploads',
        sql: `CREATE TABLE IF NOT EXISTS case_pending_uploads (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            case_program_id INTEGER NOT NULL,
            storage_key TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            size_bytes BIGINT NOT NULL,
            multipart_upload_id TEXT,
            status TEXT DEFAULT 'initiated',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'book_orders',
        sql: `CREATE TABLE IF NOT EXISTS book_orders (
            id SERIAL PRIMARY KEY,
            order_code TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            status TEXT NOT NULL DEFAULT 'awaiting_confirmation',
            payment_mode TEXT NOT NULL DEFAULT 'counter',
            total_amount REAL NOT NULL DEFAULT 0,
            order_id INTEGER,
            qr_code_data TEXT,
            admin_confirmed_by INTEGER,
            admin_confirmed_at TIMESTAMPTZ,
            fulfilled_at TIMESTAMPTZ,
            fulfilled_by INTEGER,
            notes TEXT,
            buyer_name TEXT,
            buyer_phone TEXT,
            fulfillment_type TEXT DEFAULT 'pickup',
            courier_provider TEXT,
            courier_tracking_no TEXT,
            courier_charge REAL DEFAULT 0,
            courier_dispatched_at TIMESTAMPTZ,
            delivery_address TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'book_order_items',
        sql: `CREATE TABLE IF NOT EXISTS book_order_items (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            language TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL DEFAULT 0
        )`
    },
    {
        name: 'book_fulfillment_scans',
        sql: `CREATE TABLE IF NOT EXISTS book_fulfillment_scans (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            scanner_user_id INTEGER,
            outcome TEXT NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'whatsapp_delivery_events',
        sql: `CREATE TABLE IF NOT EXISTS whatsapp_delivery_events (
            id SERIAL PRIMARY KEY,
            message_id TEXT,
            recipient TEXT,
            status TEXT,
            error_detail TEXT,
            raw_json TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    }
];

const PAYMENT_GATEWAY_SEED = [
    ['razorpay', 0, '{}'],
    ['payu', 0, '{}'],
    ['easebuzz', 0, '{}'],
    ['paytm', 0, '{}'],
    ['phonepe', 0, '{}'],
    ['cashfree', 0, '{}'],
    ['juspay', 0, '{}'],
    ['zoho', 0, '{}']
];

/** Idempotent column adds for case_programs created before newer fields existed. */
const BOOK_ORDERS_COLUMN_ALTERS = [
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS buyer_name TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS buyer_phone TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT DEFAULT \'pickup\'',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_provider TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_tracking_no TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_charge REAL DEFAULT 0',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_dispatched_at TIMESTAMPTZ',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS delivery_address TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_recipient_name TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_phone TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_pincode TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_city TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_state TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_shipment_status TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_details_saved_at TIMESTAMPTZ',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_status TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_label TEXT',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_updated_at TIMESTAMPTZ',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_delivered_at TIMESTAMPTZ',
    'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_integration TEXT DEFAULT \'direct\''
];

const BOOK_COURIER_TRACK_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS book_courier_track_events (
    id SERIAL PRIMARY KEY,
    book_order_id INTEGER NOT NULL,
    event_at TIMESTAMPTZ,
    location TEXT,
    description TEXT NOT NULL,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)`;

const BOOK_ORDER_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS book_order_events (
    id SERIAL PRIMARY KEY,
    book_order_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    meta_json TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)`;

const CASE_SUBMISSIONS_COLUMN_ALTERS = [
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS application_no TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS case_program_id INTEGER',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS category TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS form_data TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS registration_id INTEGER',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS seminar_forward_skipped INTEGER DEFAULT 0',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS plagiarism_zero INTEGER DEFAULT 0',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS winner_flag INTEGER DEFAULT 0',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS admin_notes TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS doc_review_json TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS marking_deadline TIMESTAMPTZ'
];

const CASE_PROGRAMS_COLUMN_ALTERS = [
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS form_config_json TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_presentations_per_user INTEGER DEFAULT 2',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_total_submissions INTEGER',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_files_per_submission INTEGER DEFAULT 5',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_file_size_mb INTEGER DEFAULT 50',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS enabled_categories TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS instructions TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS portal_year INTEGER',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS judge_criteria_json TEXT'
];

async function ensureCaseProgramsColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of CASE_PROGRAMS_COLUMN_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] case_programs column:', e.message);
            }
        }
    }
    for (const sql of CASE_SUBMISSIONS_COLUMN_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] case_submissions column:', e.message);
            }
        }
    }
}

async function listMissingAuxTables(queryFn) {
    const names = AUX_TABLE_DDL.map((t) => t.name);
    const r = await queryFn(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [names],
        2
    );
    const found = new Set((r.rows || []).map((row) => row.table_name));
    return names.filter((n) => !found.has(n));
}

/** Certificate verify, scan counts, document review — must run before API traffic on Vercel. */
const CERTIFICATE_TEMPLATES_PG_ALTERS = [
    'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS config_json TEXT',
    'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS signature_left_path TEXT',
    'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS signature_right_path TEXT'
];

const CERTIFICATE_VERIFY_PG_ALTERS = [
    'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_enabled INTEGER DEFAULT 0',
    'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_manual INTEGER DEFAULT 0',
    'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_go_live_at TIMESTAMPTZ',
    'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS cert_scans_required INTEGER DEFAULT 1',
    'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS scan_count INTEGER DEFAULT 0',
    'ALTER TABLE registrations ADD COLUMN IF NOT EXISTS doc_review_json TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS doc_review_json TEXT',
    'ALTER TABLE case_submissions ADD COLUMN IF NOT EXISTS marking_deadline TIMESTAMPTZ',
    'ALTER TABLE user_certificates ADD COLUMN IF NOT EXISTS verify_token TEXT',
    'ALTER TABLE user_certificates ADD COLUMN IF NOT EXISTS dispatched_at TEXT',
    'ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS verify_token TEXT',
    'ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS dispatched_at TEXT',
    'ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS scan_time TIMESTAMPTZ',
    'ALTER TABLE seminar_volunteers ADD COLUMN IF NOT EXISTS duties TEXT'
];

const ACTIVITY_LOG_INDEX_PG = [
    'CREATE INDEX IF NOT EXISTS idx_activity_created ON user_activity_logs (created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_activity_user ON user_activity_logs (user_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_activity_action ON user_activity_logs (action, created_at DESC)'
];

const NOTIFICATION_PLATFORM_PG_ALTERS = [
    'ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS provider_message_id TEXT'
];

const NOTIFICATION_PLATFORM_INDEX_PG = [
    'CREATE INDEX IF NOT EXISTS idx_notif_tpl_event ON notification_templates (event_key, seminar_id)',
    'CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_logs (created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_notif_log_provider_msg ON notification_logs (provider_message_id)',
    'CREATE INDEX IF NOT EXISTS idx_wa_delivery_msg ON whatsapp_delivery_events (message_id, created_at DESC)'
];

async function ensureActivityLogIndexes(queryWithRetry, isIgnorablePgError) {
    for (const sql of ACTIVITY_LOG_INDEX_PG) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] activity log index:', e.message);
            }
        }
    }
}

async function ensureNotificationPlatformSchema(queryWithRetry, isIgnorablePgError) {
    for (const sql of NOTIFICATION_PLATFORM_PG_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] notification column:', e.message);
            }
        }
    }
    for (const sql of NOTIFICATION_PLATFORM_INDEX_PG) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] notification index:', e.message);
            }
        }
    }
}

async function ensureCertificateTemplatesColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of CERTIFICATE_TEMPLATES_PG_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] certificate_templates column:', e.message);
            }
        }
    }
}

async function ensureBookOrdersColumns(queryWithRetry, isIgnorablePgError) {
    try {
        await queryWithRetry(BOOK_ORDER_EVENTS_DDL, [], 2);
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] book_order_events:', e.message);
        }
    }
    try {
        await queryWithRetry(BOOK_COURIER_TRACK_EVENTS_DDL, [], 2);
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] book_courier_track_events:', e.message);
        }
    }
    for (const sql of BOOK_ORDERS_COLUMN_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] book_orders column:', e.message);
            }
        }
    }
}

async function ensureCertificateVerifyColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of CERTIFICATE_VERIFY_PG_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] certificate verify column:', e.message);
            }
        }
    }
    try {
        await queryWithRetry(
            `UPDATE tickets SET scan_count = 1 WHERE COALESCE(is_scanned::int, 0) = 1 AND COALESCE(scan_count, 0) = 0`,
            [],
            1
        );
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] tickets scan_count backfill:', e.message);
        }
    }
}

const USER_PORTAL_AUTH_PG_ALTERS = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 1',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_modules TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_modules TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_category TEXT DEFAULT \'regular\'',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_modules TEXT'
];

async function ensureUserPortalColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of USER_PORTAL_AUTH_PG_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] users portal column:', e.message);
            }
        }
    }
}

/** Full support ticket API columns (legacy Neon tables only had tracking_id). */
const SUPPORT_TICKETS_PG_ALTERS = [
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ticket_id TEXT',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category TEXT',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS description TEXT',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT \'medium\'',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS attachment_path TEXT',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to_admin INTEGER',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ',
    'ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS admin_response TEXT'
];

async function ensureSupportTicketsColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of SUPPORT_TICKETS_PG_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] support_tickets column:', e.message);
            }
        }
    }
    try {
        await queryWithRetry(
            `UPDATE support_tickets SET ticket_id = tracking_id
             WHERE (ticket_id IS NULL OR TRIM(ticket_id) = '')
               AND tracking_id IS NOT NULL AND TRIM(tracking_id) <> ''`,
            [],
            1
        );
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] support_tickets ticket_id backfill:', e.message);
        }
    }
    try {
        await queryWithRetry(
            'CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id)',
            [],
            1
        );
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] ticket_messages index:', e.message);
        }
    }
}

async function ensureAuxiliaryTables(queryWithRetry, isIgnorablePgError) {
    const missingBefore = await listMissingAuxTables(queryWithRetry);
    if (missingBefore.length) {
        console.log('[pg-schema] ensuring auxiliary tables:', missingBefore.join(', '));
    }
    lastAuxDdlErrors = [];
    for (const def of AUX_TABLE_DDL) {
        try {
            await queryWithRetry(def.sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                const brief = `${def.name}: ${e.message}`;
                lastAuxDdlErrors.push(brief);
                console.error('[pg-schema] auxiliary table failed:', brief);
            }
        }
    }
    try {
        for (const row of PAYMENT_GATEWAY_SEED) {
            await queryWithRetry(
                `INSERT INTO payment_gateways (name, is_active, config) VALUES ($1, $2, $3)
                 ON CONFLICT (name) DO NOTHING`,
                row,
                1
            );
        }
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] payment_gateways seed:', e.message);
        }
    }
    await ensureCaseProgramsColumns(queryWithRetry, isIgnorablePgError);
    await ensureCertificateTemplatesColumns(queryWithRetry, isIgnorablePgError);
    await ensureCertificateVerifyColumns(queryWithRetry, isIgnorablePgError);
    await ensureBookOrdersColumns(queryWithRetry, isIgnorablePgError);
    await ensureActivityLogIndexes(queryWithRetry, isIgnorablePgError);
    await ensureNotificationPlatformSchema(queryWithRetry, isIgnorablePgError);
    await ensureUserPortalColumns(queryWithRetry, isIgnorablePgError);
    await ensureSupportTicketsColumns(queryWithRetry, isIgnorablePgError);
    try {
        await queryWithRetry(
            'CREATE INDEX IF NOT EXISTS idx_case_msg_sub ON case_participant_messages (submission_id, created_at ASC)',
            [],
            1
        );
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] case_participant_messages index:', e.message);
        }
    }
    for (const sql of [
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT',
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount REAL DEFAULT 0',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS show_seats_public INTEGER DEFAULT 1',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS preregistration_enabled INTEGER DEFAULT 0',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS preregistration_start TIMESTAMPTZ',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS preregistration_end TIMESTAMPTZ',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS waiting_list_enabled INTEGER DEFAULT 0',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS allow_application_edit INTEGER DEFAULT 0',
        'ALTER TABLE seminars ADD COLUMN IF NOT EXISTS auto_confirm_registration INTEGER DEFAULT 0',
        'ALTER TABLE registration_overrides ADD COLUMN IF NOT EXISTS register_until TIMESTAMPTZ',
        'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS show_seats_public INTEGER DEFAULT 1',
        'ALTER TABLE seminar_feedback ADD COLUMN IF NOT EXISTS answers_json TEXT',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_complete INTEGER DEFAULT 1'
    ]) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] orders refund column:', e.message);
            }
        }
    }
    return listMissingAuxTables(queryWithRetry);
}

function getLastAuxDdlErrors() {
    return lastAuxDdlErrors.slice();
}

module.exports = {
    AUX_TABLE_DDL,
    getLastAuxDdlErrors,
    CASE_PROGRAMS_COLUMN_ALTERS,
    CERTIFICATE_VERIFY_PG_ALTERS,
    CERTIFICATE_TEMPLATES_PG_ALTERS,
    SUPPORT_TICKETS_PG_ALTERS,
    ensureAuxiliaryTables,
    ensureCaseProgramsColumns,
    ensureCertificateTemplatesColumns,
    ensureCertificateVerifyColumns,
    ensureBookOrdersColumns,
    BOOK_ORDERS_COLUMN_ALTERS,
    ensureNotificationPlatformSchema,
    ensureUserPortalColumns,
    ensureSupportTicketsColumns,
    listMissingAuxTables
};
