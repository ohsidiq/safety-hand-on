"use client";

import { useEffect, useId, useState } from "react";
import { apiGet } from "@/lib/api";
import type { Department, Division, JobPosition, Site } from "@/lib/org";
import { useSession } from "@/lib/session";

export interface Placement {
  site_id: string;
  department_id: string;
  division_id: string;
  job_position_id: string;
}

export const EMPTY_PLACEMENT: Placement = { site_id: "", department_id: "", division_id: "", job_position_id: "" };

/** Pilihan Site, Department, Divisi, Job Position yang aktif dan dalam scope pemanggil (lewat Core API). */
export function PlacementFields({ value, onChange }: { value: Placement; onChange: (p: Placement) => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [sites, setSites] = useState<Site[]>([]);
  const [positions, setPositions] = useState<JobPosition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const [s, p] = await Promise.all([
        apiGet<Site[]>("/sites?status=ACTIVE", token),
        apiGet<JobPosition[]>("/job-positions?status=ACTIVE", token),
      ]);
      if (s.ok) setSites(s.data);
      if (p.ok) setPositions(p.data);
    })();
  }, [getToken]);

  useEffect(() => {
    setDepartments([]);
    if (!value.site_id) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<Department[]>(`/sites/${value.site_id}/departments?status=ACTIVE`, token);
      if (r.ok) setDepartments(r.data);
    })();
  }, [getToken, value.site_id]);

  useEffect(() => {
    setDivisions([]);
    if (!value.department_id) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<Division[]>(`/departments/${value.department_id}/divisions?status=ACTIVE`, token);
      if (r.ok) setDivisions(r.data);
    })();
  }, [getToken, value.department_id]);

  return (
    <>
      <label htmlFor={`${id}-site`}>
        Site (wajib)
        <select
          id={`${id}-site`}
          required
          value={value.site_id}
          onChange={(e) => onChange({ ...value, site_id: e.target.value, department_id: "", division_id: "" })}
        >
          <option value="">Pilih Site</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-dep`}>
        Department (wajib)
        <select
          id={`${id}-dep`}
          required
          disabled={!value.site_id}
          value={value.department_id}
          onChange={(e) => onChange({ ...value, department_id: e.target.value, division_id: "" })}
        >
          <option value="">{value.site_id ? "Pilih department" : "Pilih Site dulu"}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.code})
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-div`}>
        Divisi
        <select
          id={`${id}-div`}
          disabled={divisions.length === 0}
          value={value.division_id}
          onChange={(e) => onChange({ ...value, division_id: e.target.value })}
        >
          <option value="">(tidak ada)</option>
          {divisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.code})
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-pos`}>
        Job Position (wajib)
        <select
          id={`${id}-pos`}
          required
          value={value.job_position_id}
          onChange={(e) => onChange({ ...value, job_position_id: e.target.value })}
        >
          <option value="">Pilih posisi</option>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.code})
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
