import { useEffect, useState } from "react";

import { useNavigate, useSearchParams } from "react-router-dom";

import { useSpecialFocus } from "../hooks/useSpecialFocus";

import { createTrainSession } from "../train/createSession";

import { DEFAULT_TRAIN_CONFIG } from "../train/defaults";

import {

  clearActiveSessionId,

  getActiveSessionId,

  loadCapitalDefaults,

  loadTrainConfig,

  reclaimTrainStorage,

  upsertSession,

} from "../train/storage";



export function TrainEntryPage() {

  const nav = useNavigate();

  const [params] = useSearchParams();

  const { symbols: focusSymbols } = useSpecialFocus();

  const [err, setErr] = useState("");

  const forceNew = params.get("new") === "1";

  const focusKey = focusSymbols.join(",");



  useEffect(() => {

    let cancelled = false;



    (async () => {

      setErr("");

      try {

        if (forceNew) {

          clearActiveSessionId();

          reclaimTrainStorage(6);

        } else {

          const activeId = getActiveSessionId();

          if (activeId) {

            nav(`/train/session/${activeId}`, { replace: true });

            return;

          }

        }



        const base = loadTrainConfig();

        const symbols =

          focusSymbols.length > 0

            ? [...new Set(focusSymbols.map((s) => s.toUpperCase()))]

            : base.symbols;



        const session = await createTrainSession({

          ...DEFAULT_TRAIN_CONFIG,

          ...base,

          symbols,

          timeframes: ["15m", "1h", "4h"],

          randomizeTimeframe: false,

          preset: "full",

          capital: { ...loadCapitalDefaults(), requireStopLoss: false, leverage: 20 },

          indicators: { ma: [20, 60], volume: true, extraOff: false },

        });



        if (cancelled) return;



        if (!upsertSession(session)) {

          reclaimTrainStorage(0);

          if (!upsertSession(session)) {

            setErr(

              "本机训练存档过大，已自动清理旧局与 demo 仍无法保存。请少点「载入假数据」，或清除本站 localStorage 后重试。",

            );

            return;

          }

        }

        nav(`/train/session/${session.id}`, { replace: true });

      } catch (e) {

        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));

      }

    })();



    return () => {

      cancelled = true;

    };

  }, [nav, forceNew, focusKey]);



  if (err) {

    return (

      <div className="train-empty">

        <p className="train-error">{err}</p>

        <button type="button" onClick={() => nav("/train?new=1", { replace: true })}>

          重试

        </button>

      </div>

    );

  }



  return (

    <div className="train-empty">

      <p className="train-muted">正在抽取 15m / 1h / 4h 历史片段…</p>

    </div>

  );

}

