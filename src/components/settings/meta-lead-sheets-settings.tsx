'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Table2, XCircle } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  email: string | null;
  lastError: string | null;
}

/**
 * Google Sheets connection — Settings → Meta. Connection ONLY:
 * connect/disconnect plus connection status. All spreadsheet, tab,
 * form, and column configuration moved to each Meta Lead Ads
 * Workspace table ("Configure Sheet"). Flow Tables sheets are
 * untouched. Disconnecting never deletes spreadsheet data.
 */
export function MetaLeadSheetsSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const readJson = async (res: Response) => {
    const json = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      throw new Error(
        typeof json.error === 'string'
          ? json.error
          : `Request failed (${res.status})`
      );
    }
    return json;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = (await readJson(
        await fetch('/api/integrations/meta-lead-ads/google/status', {
          cache: 'no-store',
        })
      )) as unknown as GoogleStatus;
      setStatus(json);
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        if (params.get('meta_sheets') === 'connected') {
          toast.success(
            'Google account connected. Configure each Workspace table from the Workspace page.'
          );
        } else if (params.get('meta_sheets') === 'error') {
          toast.error(
            `Google authorization failed (${params.get('reason') ?? 'unknown'}).`
          );
        }
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load Google connection.'
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  function disconnect() {
    if (
      !window.confirm(
        'Disconnect Google Sheets? Tables stop syncing, but sheet contents stay.'
      )
    ) {
      return;
    }
    void act('disconnect', async () => {
      await readJson(
        await fetch('/api/integrations/meta-lead-ads/google/disconnect', {
          method: 'POST',
        })
      );
      toast.success('Google Sheets disconnected.');
      await load();
    });
  }

  const disabled = !canEditSettings || profileLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Table2 className="size-4" /> Google Sheets
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect the Google account used for Meta Lead Ads Workspace tables.
          Each table is configured separately from the Workspace page
          (“Configure Sheet”), with its own spreadsheet, worksheet, and columns.
          Meta-only — Flow Tables are never synced here. Disconnecting stops
          syncing but never deletes spreadsheet contents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : !status?.configured ? (
          <p className="text-muted-foreground text-sm">
            The server is missing Google OAuth credentials (GOOGLE_CLIENT_ID /
            GOOGLE_CLIENT_SECRET). Ask your administrator to set them.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {status.connected ? (
                <Badge variant="secondary">
                  <CheckCircle2 className="mr-1 size-3" />{' '}
                  {status.email ?? 'Connected'}
                </Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
              {status.needsReauth ? (
                <Badge variant="destructive">Needs reconnect</Badge>
              ) : null}
            </div>
            {status.lastError ? (
              <p className="text-destructive flex items-start gap-2 text-xs">
                <XCircle className="mt-0.5 size-3.5 shrink-0" />{' '}
                {status.lastError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {!status.connected ? (
                <Button
                  onClick={() => {
                    window.location.href =
                      '/api/integrations/meta-lead-ads/google/connect';
                  }}
                  disabled={disabled}
                >
                  Connect Google account
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={disconnect}
                  disabled={disabled || busy === 'disconnect'}
                >
                  {busy === 'disconnect' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Disconnect
                </Button>
              )}
            </div>

            <p className="text-muted-foreground text-xs">
              To sync a table, open Workspace, select a Meta Lead Ads table, and
              choose “Configure Sheet”.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
