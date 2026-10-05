<?php

namespace App\Gogate;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema as DatabaseSchema;

class Schema
{
    public static function ensure(): void
    {
        if (!DatabaseSchema::hasTable('gogate_hubs')) {
            DB::statement(
                'CREATE TABLE gogate_hubs (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    uuid CHAR(36) NOT NULL,
                    public_id VARCHAR(191) NOT NULL,
                    company_uuid CHAR(36) NOT NULL,
                    place_uuid CHAR(36) NULL,
                    name VARCHAR(191) NOT NULL,
                    locality VARCHAR(191) NULL,
                    address VARCHAR(255) NOT NULL,
                    city VARCHAR(191) NOT NULL,
                    state VARCHAR(191) NOT NULL,
                    country VARCHAR(191) NOT NULL,
                    postal_code VARCHAR(32) NULL,
                    role VARCHAR(64) NOT NULL,
                    mode VARCHAR(32) NOT NULL DEFAULT \'both\',
                    active TINYINT NOT NULL DEFAULT 1,
                    created_at TIMESTAMP NULL,
                    updated_at TIMESTAMP NULL,
                    deleted_at TIMESTAMP NULL,
                    UNIQUE KEY gogate_hubs_uuid (uuid),
                    UNIQUE KEY gogate_hubs_public (public_id),
                    KEY gogate_hubs_company (company_uuid)
                )'
            );
        }

        if (!DatabaseSchema::hasTable('gogate_settings')) {
            DB::statement(
                'CREATE TABLE gogate_settings (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    company_uuid CHAR(36) NOT NULL,
                    name VARCHAR(64) NOT NULL,
                    value TEXT NULL,
                    updated_at TIMESTAMP NULL,
                    UNIQUE KEY gogate_settings_company_name (company_uuid, name)
                )'
            );
        }
    }
}
