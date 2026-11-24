// Supabase-shaped TEST ONLY storage/table adapter. Never imported by runtime.
export function galleryClientFixture() {
  const rows = [],
    files = new Map();
  let failInsert = false;
  const client = {
    from(table) {
      if (table !== "admin_gallery_notes") throw new Error(`Unexpected database access: ${table}`);
      let fields = "*",
        filters = [],
        start = 0,
        end = 10000,
        inserted;
      const query = {
        select(value) {
          fields = value;
          return query;
        },
        order() {
          return query;
        },
        range(a, b) {
          start = a;
          end = b;
          return query;
        },
        eq(key, value) {
          filters.push([key, value]);
          return query;
        },
        insert(value) {
          inserted = value;
          return query;
        },
        single() {
          return query.then((result) => ({ ...result, data: result.data?.[0] ?? null }));
        },
        maybeSingle() {
          return query.single();
        },
        async then(resolve, reject) {
          try {
            if (inserted && failInsert)
              return resolve({ data: null, error: { message: "synthetic failure" } });
            if (inserted) rows.unshift({ ...inserted, created_at: new Date().toISOString() });
            const data = rows
              .filter((row) => filters.every(([key, value]) => row[key] === value))
              .slice(start, end + 1)
              .map((row) => Object.fromEntries(fields.split(",").map((key) => [key, row[key]])));
            return resolve({ data, error: null });
          } catch (error) {
            if (reject) return reject(error);
            throw error;
          }
        },
      };
      return query;
    },
    async rpc(name) {
      if (name !== "admin_gallery_catalog") throw new Error(`Unexpected RPC: ${name}`);
      return {
        data: [
          ...new Map(
            rows.map(({ course, semester, subject }) => [
              JSON.stringify([course, semester, subject]),
              { course, semester, subject },
            ]),
          ).values(),
        ],
        error: null,
      };
    },
    storage: {
      from(bucket) {
        if (bucket !== "admin-gallery-pdfs") throw new Error("Unexpected storage bucket");
        return {
          async upload(path, bytes) {
            files.set(path, bytes);
            return { error: null };
          },
          async remove(paths) {
            paths.forEach((path) => files.delete(path));
            return { error: null };
          },
          async createSignedUrl(path) {
            return {
              data: { signedUrl: `https://fixture.invalid/${path}?token=synthetic` },
              error: null,
            };
          },
          async download(path) {
            const bytes = files.get(path);
            return {
              data: bytes ? new Blob([bytes], { type: "application/pdf" }) : null,
              error: bytes ? null : { message: "not found" },
            };
          },
        };
      },
    },
  };
  return {
    client,
    rows,
    files,
    setFailInsert: (value) => {
      failInsert = value;
    },
  };
}
