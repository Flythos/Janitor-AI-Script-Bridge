// Janitor AI Script Bridge — debug report rendering
//
// Renders the per-generation report (Janitor's "Changes" tab equivalent) into
// a popup: per-script console output, character field diffs, errors, and the
// World Info gating decisions.

import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';
import { escapeHtml } from '/scripts/utils.js';

/**
 * Renders a report object into HTML (escaped; safe for arbitrary script output).
 */
export function renderReportHtml(report) {
    const parts = [];
    parts.push(`<div><b>When:</b> ${escapeHtml(report.timestamp ?? '')} &nbsp; <b>Type:</b> ${escapeHtml(report.type ?? '')} &nbsp; <b>Character:</b> ${escapeHtml(report.character ?? '')}</div>`);

    if (report.skipped) {
        parts.push(`<div class="jai-empty">${escapeHtml(report.skipped)}</div>`);
    }

    if (Array.isArray(report.gating) && report.gating.length > 0) {
        const rows = report.gating
            .map(item => `<li>${escapeHtml(item.book)} · uid ${escapeHtml(String(item.uid))} · ${escapeHtml(item.comment ?? '')} — ${escapeHtml(item.reason ?? '')}</li>`)
            .join('');
        parts.push(`<div class="jai-gating-summary"><b>World Info gating:</b><ul>${rows}</ul></div>`);
    }

    for (const run of report.runs ?? []) {
        const status = run.ok
            ? '<span class="jai-ok">ok</span>'
            : `<span class="jai-run-error">failed${run.timedOut ? ' (timeout)' : ''}</span>`;
        const scope = run.scope === 'chat'
            ? 'chat'
            : run.scope === 'char'
                ? 'char'
                : '';
        const scopeHtml = scope ? ` <span class="jai-badge">[${escapeHtml(scope)}]</span>` : '';
        const runParts = [
            `<div class="jai-run-title">${scopeHtml}${escapeHtml(run.title)} — ${status} — ${escapeHtml(String(run.durationMs))} ms — sandbox: ${escapeHtml(run.strategy ?? '')}</div>`,
        ];
        if (run.error) {
            runParts.push(`<div class="jai-run-error">${escapeHtml(run.error)}</div>`);
        }
        if (Array.isArray(run.logs) && run.logs.length > 0) {
            runParts.push(`<pre class="jai-logs">${escapeHtml(run.logs.join('\n'))}</pre>`);
        }
        const changes = Object.entries(run.changes ?? {});
        if (changes.length > 0) {
            const diffHtml = changes
                .map(([field, diff]) => `<div class="jai-diff"><b>${escapeHtml(field)}</b>\n${escapeHtml(diff)}</div>`)
                .join('');
            runParts.push(diffHtml);
        } else if (run.ok) {
            runParts.push('<div class="jai-empty">No character fields changed.</div>');
        }
        parts.push(`<div class="jai-run">${runParts.join('')}</div>`);
    }

    const injected = report.injection?.fields ?? [];
    if (injected.length > 0) {
        const rows = injected
            .map(item => `<li><b>${escapeHtml(item.field)}</b> (${escapeHtml(report.injection?.mode ?? '')}): ${escapeHtml(item.diff ?? '')}</li>`)
            .join('');
        parts.push(`<div class="jai-injection-summary"><b>Injected for this generation:</b><ul>${rows}</ul></div>`);
    }

    return `<div class="jai-debug-report">${parts.join('')}</div>`;
}

/**
 * Shows the report in a wide popup.
 */
export async function showReportPopup(report) {
    await callGenericPopup($(renderReportHtml(report)), POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
    });
}
