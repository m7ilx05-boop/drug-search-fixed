// retired probe: does nothing.
Deno.serve(() => new Response("gone", { status: 410 }));
