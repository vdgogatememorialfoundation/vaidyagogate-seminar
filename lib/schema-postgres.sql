-- Auto-generated from SQLite schema — Neon / Vercel
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id_string TEXT UNIQUE,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        whatsapp TEXT,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'doctor',
        qualification TEXT,
        practitioner_type TEXT,
        registration_cert_path TEXT,
        registration_cert_no TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    , is_disabled INTEGER DEFAULT 0, user_role TEXT DEFAULT 'doctor', admin_modules TEXT, doctor_category TEXT DEFAULT 'regular', doctor_modules TEXT, is_demo INTEGER DEFAULT 0, last_login_at TIMESTAMPTZ, email_verified INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS seminars (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        registration_start TIMESTAMPTZ,
        registration_end TIMESTAMPTZ,
        event_date TIMESTAMPTZ,
        capacity INTEGER,
        is_active BOOLEAN DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    , custom_fields_schema TEXT DEFAULT '{}', price REAL DEFAULT 0, checkin_enabled BOOLEAN DEFAULT 0, checkin_date DATE, location_url TEXT, terms_conditions TEXT, is_countdown_active BOOLEAN DEFAULT 0, hero_image_path TEXT, flyer_path TEXT, gallery_paths TEXT, registration_form_json TEXT, cancellation_policy_json TEXT, whatsapp_group_url TEXT, otp_on_application INTEGER DEFAULT 0, portal_year INTEGER, public_list_enabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS abstracts (
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
    );
CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        seminar_id INTEGER,
        application_no TEXT UNIQUE,
        status TEXT DEFAULT 'pending_approval',
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        form_data TEXT,
        registration_source TEXT DEFAULT 'doctor',
        admin_editor_user_id INTEGER,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    );
CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id_string TEXT UNIQUE,
        registration_id INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending',
        payment_date TIMESTAMPTZ, payment_gateway TEXT, provider_order_id TEXT, provider_transaction_id TEXT,
        FOREIGN KEY (registration_id) REFERENCES registrations(id)
    );
CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        order_id INTEGER,
        user_id INTEGER,
        qr_code_data TEXT UNIQUE,
        is_scanned BOOLEAN DEFAULT 0,
        scan_time TIMESTAMPTZ, scanned_by INTEGER, ticket_id_string TEXT, is_valid INTEGER DEFAULT 1,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );
CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        tracking_id TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        status TEXT DEFAULT 'Open',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS support_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS notices (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        pdf_path TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        title TEXT,
        html_content TEXT
    );
CREATE TABLE IF NOT EXISTS schedule (
        id SERIAL PRIMARY KEY,
        date_str TEXT,
        time_str TEXT,
        session_title TEXT,
        speaker TEXT
    );
CREATE TABLE IF NOT EXISTS payment_gateways (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        is_active BOOLEAN DEFAULT 0,
        config TEXT
    );
CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    role_name TEXT UNIQUE,
    description TEXT,
    permissions TEXT
);
CREATE TABLE IF NOT EXISTS application_edits (
    id SERIAL PRIMARY KEY,
    application_id INTEGER,
    edited_by_user_id INTEGER,
    changes TEXT,
    edited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES registrations(id)
);
CREATE TABLE IF NOT EXISTS doctor_profile (
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
);
CREATE TABLE IF NOT EXISTS event_schedules (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        seminar_id INTEGER,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        location TEXT,
        speaker_name TEXT,
        speaker_bio TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    );
CREATE TABLE IF NOT EXISTS seminar_feedback (
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
        would_attend_again BOOLEAN DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id),
        FOREIGN KEY (registration_id) REFERENCES registrations(id)
    );
CREATE TABLE IF NOT EXISTS ticket_messages (
        id SERIAL PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_type TEXT,
        message TEXT NOT NULL,
        attachment_path TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(ticket_id)
    );
CREATE TABLE IF NOT EXISTS live_chat_sessions (
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
    );
CREATE TABLE IF NOT EXISTS live_chat_messages (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_type TEXT,
        message TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES live_chat_sessions(session_id)
    );
CREATE TABLE IF NOT EXISTS interactive_session_registrations (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            registration_id INTEGER NOT NULL,
            seminar_id INTEGER,
            form_data TEXT,
            ticket_id_string TEXT UNIQUE,
            status TEXT DEFAULT 'registered',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE IF NOT EXISTS otp_codes (
            id SERIAL PRIMARY KEY,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            purpose TEXT NOT NULL,
            meta TEXT,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE IF NOT EXISTS otp_verification_tokens (
            id SERIAL PRIMARY KEY,
            token_hash TEXT NOT NULL,
            purpose TEXT NOT NULL,
            channel TEXT NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE IF NOT EXISTS email_verify_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE IF NOT EXISTS notification_queue (
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
        );
CREATE TABLE IF NOT EXISTS refunds (
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
        );
CREATE TABLE IF NOT EXISTS registration_reminder_log (
            registration_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (registration_id, sent_date)
        );
CREATE TABLE IF NOT EXISTS certificate_templates (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER,
            file_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            uploaded_by INTEGER,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, cert_type TEXT DEFAULT 'participant',
            FOREIGN KEY (seminar_id) REFERENCES seminars(id)
        );
CREATE TABLE IF NOT EXISTS user_certificates (
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
                    UNIQUE(user_id, seminar_id),
                    FOREIGN KEY (seminar_id) REFERENCES seminars(id)
                );
CREATE TABLE IF NOT EXISTS registration_overrides (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                seminar_id INTEGER NOT NULL,
                enabled INTEGER DEFAULT 1,
                note TEXT,
                created_by INTEGER,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, seminar_id)
            );
CREATE TABLE IF NOT EXISTS seminar_volunteers (
                        id SERIAL PRIMARY KEY,
                        seminar_id INTEGER NOT NULL,
                        user_id INTEGER NOT NULL,
                        status TEXT DEFAULT 'pending',
                        approved_by INTEGER,
                        approved_at TIMESTAMPTZ,
                        volunteer_ticket_id_string TEXT,
                        notes TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(seminar_id, user_id)
                    );
CREATE TABLE IF NOT EXISTS volunteer_certificates (
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
                            );
CREATE TABLE IF NOT EXISTS case_submissions (
                                            id SERIAL PRIMARY KEY,
                                            user_id INTEGER NOT NULL,
                                            seminar_id INTEGER,
                                            title TEXT NOT NULL,
                                            status TEXT DEFAULT 'draft',
                                            fee_amount REAL DEFAULT 0,
                                            order_id INTEGER,
                                            winner_flag INTEGER DEFAULT 0,
                                            admin_notes TEXT,
                                            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                                            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                                        , application_no TEXT, case_program_id INTEGER, category TEXT, form_data TEXT, registration_id INTEGER, seminar_forward_skipped INTEGER DEFAULT 0, plagiarism_zero INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS case_files (
                                                    id SERIAL PRIMARY KEY,
                                                    submission_id INTEGER NOT NULL,
                                                    file_path TEXT NOT NULL,
                                                    original_name TEXT,
                                                    status TEXT DEFAULT 'pending',
                                                    rejection_reason TEXT,
                                                    sort_order INTEGER DEFAULT 0,
                                                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                                                    FOREIGN KEY (submission_id) REFERENCES case_submissions(id)
                                                );
CREATE TABLE IF NOT EXISTS case_judge_assignments (
                                                            id SERIAL PRIMARY KEY,
                                                            submission_id INTEGER NOT NULL,
                                                            judge_user_id INTEGER NOT NULL,
                                                            assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                                                            UNIQUE(submission_id, judge_user_id)
                                                        );
CREATE TABLE IF NOT EXISTS case_judge_scores (
                                                                    id SERIAL PRIMARY KEY,
                                                                    submission_id INTEGER NOT NULL,
                                                                    judge_user_id INTEGER NOT NULL,
                                                                    criteria_json TEXT,
                                                                    total_score REAL,
                                                                    remarks TEXT,
                                                                    submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, is_locked INTEGER DEFAULT 0,
                                                                    UNIQUE(submission_id, judge_user_id)
                                                                );
CREATE TABLE IF NOT EXISTS case_programs (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                seminar_id INTEGER,
                registration_start TIMESTAMPTZ,
                registration_end TIMESTAMPTZ,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            , form_config_json TEXT, max_presentations_per_user INTEGER DEFAULT 2, max_total_submissions INTEGER, max_files_per_submission INTEGER DEFAULT 5, max_file_size_mb INTEGER DEFAULT 50, enabled_categories TEXT, instructions TEXT, portal_year INTEGER, judge_criteria_json TEXT);
CREATE TABLE IF NOT EXISTS registration_status_log (
                id SERIAL PRIMARY KEY,
                registration_id INTEGER NOT NULL,
                step_key TEXT NOT NULL,
                label TEXT,
                message TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS case_status_log (
                        id SERIAL PRIMARY KEY,
                        submission_id INTEGER NOT NULL,
                        step_key TEXT NOT NULL,
                        label TEXT,
                        message TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    );
CREATE TABLE IF NOT EXISTS homepage_banners (
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
        );

INSERT INTO payment_gateways (name, is_active, config) VALUES
 ('razorpay', 0, '{}'),
 ('payu', 0, '{}'),
 ('cashfree', 0, '{}')
 ON CONFLICT (name) DO NOTHING;
