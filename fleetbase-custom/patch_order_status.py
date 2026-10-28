#!/usr/bin/env python3
"""Point new Fleetbase shipments at the status text Shipment Created."""
import sys
from pathlib import Path

OLD_INITIAL = """    public function getInitialTrackingStatus(): ?array
    {
        if (!$this->order_config_uuid) {
            return null;
        }

        $orderConfig = OrderConfig::where('uuid', $this->order_config_uuid)->first();
        if (!$orderConfig || !$orderConfig->hasConfiguredLifecycle()) {
            return null;
        }

        $activity = $orderConfig->getInitialActivity();
        if (!$activity) {
            return null;
        }

        return [
            'code'    => $activity->code,
            'status'  => $this->resolveActivityTemplateString((string) $activity->get('status', '')),
            'details' => $this->resolveActivityTemplateString((string) $activity->get('details', '')),
        ];
    }"""

NEW_INITIAL = """    public function getInitialTrackingStatus(): ?array
    {
        $shipmentCreated = [
            'code'    => 'created',
            'status'  => 'Shipment Created',
            'details' => 'Shipment created.',
        ];

        if (!$this->order_config_uuid) {
            return $shipmentCreated;
        }

        $orderConfig = OrderConfig::where('uuid', $this->order_config_uuid)->first();
        if (!$orderConfig || !$orderConfig->hasConfiguredLifecycle()) {
            return $shipmentCreated;
        }

        $activity = $orderConfig->getInitialActivity();
        if (!$activity) {
            return $shipmentCreated;
        }

        $status = $this->resolveActivityTemplateString((string) $activity->get('status', ''));
        if ($status === '' || strcasecmp($status, 'Order Created') === 0) {
            $status = 'Shipment Created';
        }
        $details = $this->resolveActivityTemplateString((string) $activity->get('details', ''));
        if ($details === '' || strcasecmp($details, 'New order was created.') === 0) {
            $details = 'Shipment created.';
        }

        return [
            'code'    => $activity->code ?: 'created',
            'status'  => $status,
            'details' => $details,
        ];
    }"""

OLD_ACTIVITY = """        $location = $this->getLastLocation();

        $this->insertActivity($activity, $location, $proof);

        $this->setStatus($activity->get('code'), true);

        $activity->fireEvents($this);"""

NEW_ACTIVITY = """        $location = $this->getLastLocation();

        $this->insertActivity($activity, $location, $proof);

        $hubScan = in_array((string) $activity->get('code'), ['hub_received', 'hub_left'], true);
        if (!$hubScan) {
            $this->setStatus($activity->get('code'), true);
        }

        $activity->fireEvents($this);"""


def main():
    path = Path(sys.argv[1])
    text = path.read_text()
    if "Shipment Created" in text and "hub_received" in text:
        print("already_patched")
        return
    if OLD_INITIAL not in text:
        sys.exit("initial status function was not found")
    if OLD_ACTIVITY not in text:
        sys.exit("updateActivity block was not found")
    text = text.replace(OLD_INITIAL, NEW_INITIAL, 1).replace(OLD_ACTIVITY, NEW_ACTIVITY, 1)
    path.write_text(text)
    print("patched")


if __name__ == "__main__":
    main()
