<?php

namespace App\Gogate;

use Fleetbase\FleetOps\Models\Place;
use Fleetbase\LaravelMysqlSpatial\Types\Point;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class HubController extends Controller
{
    private const ROLES = ['seller_local', 'city_mother', 'transit', 'destination_city', 'delivery_local'];

    private const MODES = ['logistics', 'hyperlocal', 'both'];

    public function index()
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }

        $rows = DB::table('gogate_hubs')
            ->where('company_uuid', $company)
            ->whereNull('deleted_at')
            ->orderBy('name')
            ->get();

        return response()->json([
            'hubs' => $rows->map(fn ($row) => $this->present($row))->values(),
        ]);
    }

    public function store(Request $request)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }

        $input = $this->validated($request);
        if ($input instanceof \Illuminate\Http\JsonResponse) {
            return $input;
        }

        $place = $this->savePlace(new Place(), $company, $input);
        $now = now();
        $uuid = (string) Str::uuid();
        $publicId = 'hub_' . strtolower(Str::random(10));
        DB::table('gogate_hubs')->insert([
            'uuid' => $uuid,
            'public_id' => $publicId,
            'company_uuid' => $company,
            'place_uuid' => $place->uuid,
            'name' => $input['name'],
            'locality' => $input['locality'],
            'address' => $input['address'],
            'city' => $input['city'],
            'state' => $input['state'],
            'country' => $input['country'],
            'postal_code' => $input['postal_code'],
            'role' => $input['role'],
            'mode' => $input['mode'],
            'active' => 1,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $row = DB::table('gogate_hubs')->where('uuid', $uuid)->first();

        return response()->json(['hub' => $this->present($row)], 201);
    }

    public function update(Request $request, string $id)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $row = $this->find($company, $id);
        if (!$row) {
            return response()->json(['message' => 'Hub not found.'], 404);
        }
        $input = $this->validated($request);
        if ($input instanceof \Illuminate\Http\JsonResponse) {
            return $input;
        }

        $place = $row->place_uuid ? Place::where('uuid', $row->place_uuid)->first() : null;
        if (!$place) {
            $place = new Place();
        }
        $place = $this->savePlace($place, $company, $input);
        DB::table('gogate_hubs')->where('uuid', $row->uuid)->update([
            'place_uuid' => $place->uuid,
            'name' => $input['name'],
            'locality' => $input['locality'],
            'address' => $input['address'],
            'city' => $input['city'],
            'state' => $input['state'],
            'country' => $input['country'],
            'postal_code' => $input['postal_code'],
            'role' => $input['role'],
            'mode' => $input['mode'],
            'updated_at' => now(),
        ]);

        return response()->json(['hub' => $this->present(DB::table('gogate_hubs')->where('uuid', $row->uuid)->first())]);
    }

    public function destroy(string $id)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $row = $this->find($company, $id);
        if (!$row) {
            return response()->json(['message' => 'Hub not found.'], 404);
        }
        DB::table('gogate_hubs')->where('uuid', $row->uuid)->update([
            'deleted_at' => now(),
            'updated_at' => now(),
            'active' => 0,
        ]);
        if ($row->place_uuid) {
            $place = Place::where('uuid', $row->place_uuid)->where('company_uuid', $company)->first();
            if ($place) {
                $place->delete();
            }
        }

        return response()->json(['deleted' => true]);
    }

    private function savePlace(Place $place, string $company, array $input): Place
    {
        $place->company_uuid = $company;
        $place->name = $input['name'];
        $place->street1 = $input['address'];
        $place->neighborhood = $input['locality'];
        $place->city = $input['city'];
        $place->province = $input['state'];
        $place->postal_code = $input['postal_code'];
        $place->country = $input['country'];
        $place->type = 'hub';
        $place->location = new Point(0, 0);
        $place->meta = [
            'role' => $input['role'],
            'locality' => $input['locality'],
            'country_name' => $input['country'],
            'mode' => $input['mode'],
            'gogate_hub' => true,
        ];
        $place->save();

        return $place;
    }

    private function present(object $row): array
    {
        return [
            'id' => $row->public_id,
            'uuid' => $row->uuid,
            'name' => $row->name,
            'locality' => $row->locality,
            'street1' => $row->address,
            'neighborhood' => $row->locality,
            'city' => $row->city,
            'province' => $row->state,
            'state' => $row->state,
            'country' => $row->country,
            'postal_code' => $row->postal_code,
            'role' => $row->role,
            'mode' => $row->mode,
            'active' => (bool) $row->active,
            'type' => 'hub',
            'place_id' => $row->place_uuid,
            'meta' => [
                'role' => $row->role,
                'locality' => $row->locality,
                'country_name' => $row->country,
                'mode' => $row->mode,
            ],
        ];
    }

    private function find(string $company, string $id): ?object
    {
        return DB::table('gogate_hubs')
            ->where('company_uuid', $company)
            ->whereNull('deleted_at')
            ->where(function ($query) use ($id) {
                $query->where('public_id', $id)->orWhere('uuid', $id);
            })
            ->first();
    }

    private function validated(Request $request)
    {
        $hub = $request->input('hub', $request->all());
        $hub = is_array($hub) ? $hub : [];
        $name = trim((string) ($hub['name'] ?? ''));
        $address = trim((string) ($hub['address'] ?? $hub['street1'] ?? ''));
        $city = trim((string) ($hub['city'] ?? ''));
        $state = trim((string) ($hub['state'] ?? $hub['province'] ?? ''));
        $country = trim((string) ($hub['country'] ?? ''));
        $role = (string) ($hub['role'] ?? 'seller_local');
        $mode = (string) ($hub['mode'] ?? 'both');
        if ($name === '' || $address === '' || $city === '' || $state === '' || $country === '') {
            return response()->json(['message' => 'Enter the hub name, address, city, state, and country.'], 422);
        }
        if (!in_array($role, self::ROLES, true)) {
            return response()->json(['message' => 'Choose a hub role.'], 422);
        }
        if (!in_array($mode, self::MODES, true)) {
            $mode = 'both';
        }

        return [
            'name' => mb_substr($name, 0, 191),
            'locality' => mb_substr(trim((string) ($hub['locality'] ?? $hub['neighborhood'] ?? '')), 0, 191),
            'address' => mb_substr($address, 0, 255),
            'city' => mb_substr($city, 0, 191),
            'state' => mb_substr($state, 0, 191),
            'country' => mb_substr($country, 0, 191),
            'postal_code' => mb_substr(trim((string) ($hub['postal_code'] ?? $hub['pin'] ?? '')), 0, 32),
            'role' => $role,
            'mode' => $mode,
        ];
    }

    private function companyUuid()
    {
        $company = session('company');
        if (is_object($company) && isset($company->uuid)) {
            $company = $company->uuid;
        }
        if (!is_string($company) || $company === '') {
            return response()->json(['message' => 'Sign in again.'], 401);
        }

        return $company;
    }
}
