// Bounded transport-level retry — the integrator behaviour idempotency keys
// exist to make safe.
//
// After a fault is removed, undici's keep-alive pool can hand the next
// request a socket the fault already killed ("other side closed"): an
// ambiguous transport failure. A real integrator retries those; tests model
// it EXPLICITLY at the call site (never hidden in the client), bounded to
// one extra attempt. ONLY transport errors are retried/absorbed — anything
// else (parse bugs, assertion failures, programming errors) must propagate,
// or a broken test could pass for the wrong reason.

const TRANSPORT_ERROR = /fetch failed|other side closed|terminated|socket|ECONNRESET|ECONNREFUSED|UND_ERR|abort|timeout/i;

function isTransportError(err: unknown): boolean {
  const parts: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause as Error) {
    parts.push(e.name, e.message);
  }
  return TRANSPORT_ERROR.test(parts.join(' '));
}

export async function retryOnceOnTransportError<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!isTransportError(err)) throw err;
    console.log(`[${label}] transport error (${String(err)}) — one fresh-socket retry`);
    return attempt();
  }
}

/** Run an attempt expected to DIE at the transport layer; true iff it did. */
export async function diedAtTransport(attempt: () => Promise<unknown>): Promise<boolean> {
  try {
    await attempt();
    return false;
  } catch (err) {
    if (!isTransportError(err)) throw err;
    console.log(`[diedAtTransport] ${String(err)}`);
    return true;
  }
}
