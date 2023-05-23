import type {
  ActionFunction,
  LinksFunction,
  LoaderArgs,
} from "@remix-run/node";
import { findMatchById } from "../queries/findMatchById.server";
import {
  useLoaderData,
  useOutletContext,
  useRevalidator,
} from "@remix-run/react";
import { createTournamentMapList } from "~/modules/tournament-map-list-generator";
import { notFoundIfFalsy, parseRequestFormData, validate } from "~/utils/remix";
import { MapPool } from "~/modules/map-pool-serializer";
import { ScoreReporter } from "../components/ScoreReporter";
import { LinkButton } from "~/components/Button";
import { ArrowLongLeftIcon } from "~/components/icons/ArrowLongLeft";
import {
  tournamentBracketsPage,
  tournamentMatchSubscribePage,
} from "~/utils/urls";
import invariant from "tiny-invariant";
import { canAdminTournament, canReportTournamentScore } from "~/permissions";
import { requireUser, useUser } from "~/modules/auth";
import { getTournamentManager } from "../core/brackets-manager";
import { assertUnreachable } from "~/utils/types";
import { insertTournamentMatchGameResult } from "../queries/insertTournamentMatchGameResult.server";
import type { ModeShort, StageId } from "~/modules/in-game-lists";
import { findResultsByMatchId } from "../queries/findResultsByMatchId.server";
import { deleteTournamentMatchGameResultById } from "../queries/deleteTournamentMatchGameResultById.server";
import { useSearchParamState } from "~/hooks/useSearchParamState";
import { findByIdentifier } from "../../tournament/queries/findByIdentifier.server";
import { findTeamsByTournamentId } from "../../tournament/queries/findTeamsByTournamentId.server";
import {
  bracketSubscriptionKey,
  checkSourceIsValid,
  matchIdFromParams,
  matchSubscriptionKey,
} from "../tournament-bracket-utils";
import { matchSchema } from "../tournament-bracket-schemas.server";
import {
  modesIncluded,
  tournamentIdFromParams,
  type TournamentLoaderData,
} from "~/features/tournament";
import { insertTournamentMatchGameResultParticipant } from "../queries/insertTournamentMatchGameResultParticipant.server";
import bracketStyles from "../tournament-bracket.css";
import { sql } from "~/db/sql";
import { nanoid } from "nanoid";
import { emitter } from "../core/emitters.server";
import { useEventSource } from "remix-utils";
import * as React from "react";
import { useVisibilityChange } from "~/hooks/useVisibilityChange";

export const links: LinksFunction = () => [
  {
    rel: "stylesheet",
    href: bracketStyles,
  },
];

export const action: ActionFunction = async ({ params, request }) => {
  const user = await requireUser(request);
  const matchId = matchIdFromParams(params);
  const match = notFoundIfFalsy(findMatchById(matchId));
  const data = await parseRequestFormData({
    request,
    schema: matchSchema,
  });

  const tournamentId = tournamentIdFromParams(params);
  const event = notFoundIfFalsy(findByIdentifier(tournamentId));

  const validateCanReportScore = () => {
    const teams = findTeamsByTournamentId(tournamentId);
    const ownedTeamId = teams.find((team) =>
      team.members.some(
        (member) => member.userId === user?.id && member.isOwner
      )
    )?.id;

    validate(
      canReportTournamentScore({
        event,
        match,
        ownedTeamId,
        user,
      }),
      "Unauthorized",
      401
    );
  };

  const manager = getTournamentManager("SQL");

  const scores: [number, number] = [
    match.opponentOne?.score ?? 0,
    match.opponentTwo?.score ?? 0,
  ];

  switch (data._action) {
    case "REPORT_SCORE": {
      validateCanReportScore();
      validate(
        match.opponentOne?.id === data.winnerTeamId ||
          match.opponentTwo?.id === data.winnerTeamId,
        "Winner team id is invalid"
      );
      validate(
        checkSourceIsValid({ source: data.source, match }),
        "Source is invalid"
      );

      // they are trying to report score that was already reported
      // assume that it was already reported and make their page refresh
      if (data.position !== scores[0] + scores[1]) {
        return null;
      }

      const scoreToIncrement = () => {
        if (data.winnerTeamId === match.opponentOne?.id) return 0;
        if (data.winnerTeamId === match.opponentTwo?.id) return 1;

        validate(false, "Winner team id is invalid");
      };

      scores[scoreToIncrement()]++;

      sql.transaction(() => {
        manager.update.match({
          id: match.id,
          opponent1: {
            score: scores[0],
            result:
              scores[0] === Math.ceil(match.bestOf / 2) ? "win" : undefined,
          },
          opponent2: {
            score: scores[1],
            result:
              scores[1] === Math.ceil(match.bestOf / 2) ? "win" : undefined,
          },
        });

        const result = insertTournamentMatchGameResult({
          matchId: match.id,
          mode: data.mode as ModeShort,
          stageId: data.stageId as StageId,
          reporterId: user.id,
          winnerTeamId: data.winnerTeamId,
          number: data.position + 1,
          source: data.source,
        });

        for (const userId of data.playerIds) {
          insertTournamentMatchGameResultParticipant({
            matchGameResultId: result.id,
            userId,
          });
        }
      })();

      break;
    }
    case "UNDO_REPORT_SCORE": {
      validateCanReportScore();
      // they are trying to remove score from the past
      if (data.position !== scores[0] + scores[1] - 1) {
        return null;
      }

      const results = findResultsByMatchId(matchId);
      const lastResult = results[results.length - 1];
      invariant(lastResult, "Last result is missing");

      const shouldReset = results.length === 1;

      if (lastResult.winnerTeamId === match.opponentOne?.id) {
        scores[0]--;
      } else {
        scores[1]--;
      }

      sql.transaction(() => {
        deleteTournamentMatchGameResultById(lastResult.id);

        manager.update.match({
          id: match.id,
          opponent1: {
            score: shouldReset ? undefined : scores[0],
          },
          opponent2: {
            score: shouldReset ? undefined : scores[1],
          },
        });

        if (shouldReset) {
          manager.reset.matchResults(match.id);
        }
      })();

      break;
    }
    // TODO: bug where you can reopen losers finals after winners finals
    case "REOPEN_MATCH": {
      const scoreOne = match.opponentOne?.score ?? 0;
      const scoreTwo = match.opponentTwo?.score ?? 0;
      invariant(typeof scoreOne === "number", "Score one is missing");
      invariant(typeof scoreTwo === "number", "Score two is missing");
      invariant(scoreOne !== scoreTwo, "Scores are equal");

      validate(canAdminTournament({ event, user }));

      const results = findResultsByMatchId(matchId);
      const lastResult = results[results.length - 1];
      invariant(lastResult, "Last result is missing");

      if (scoreOne > scoreTwo) {
        scores[0]--;
      } else {
        scores[1]--;
      }

      try {
        sql.transaction(() => {
          deleteTournamentMatchGameResultById(lastResult.id);
          manager.update.match({
            id: match.id,
            opponent1: {
              score: scores[0],
              result: undefined,
            },
            opponent2: {
              score: scores[1],
              result: undefined,
            },
          });
        })();
      } catch (err) {
        if (!(err instanceof Error)) throw err;

        if (err.message.includes("locked")) {
          return { error: "locked" };
        }

        throw err;
      }

      break;
    }
    default: {
      assertUnreachable(data);
    }
  }

  emitter.emit(matchSubscriptionKey(match.id), {
    eventId: nanoid(),
    userId: user.id,
  });
  emitter.emit(bracketSubscriptionKey(event.id), {
    matchId: match.id,
    scores,
    isOver:
      scores[0] === Math.ceil(match.bestOf / 2) ||
      scores[1] === Math.ceil(match.bestOf / 2),
  });

  return null;
};

export type TournamentMatchLoaderData = typeof loader;

export const loader = ({ params }: LoaderArgs) => {
  const matchId = matchIdFromParams(params);

  const match = notFoundIfFalsy(findMatchById(matchId));

  return {
    match,
    results: findResultsByMatchId(matchId),
    seeds: resolveSeeds(),
  };

  function resolveSeeds() {
    const tournamentId = tournamentIdFromParams(params);
    const teams = findTeamsByTournamentId(tournamentId);

    const teamOneIndex = teams.findIndex(
      (team) => team.id === match.opponentOne?.id
    );
    const teamTwoIndex = teams.findIndex(
      (team) => team.id === match.opponentTwo?.id
    );

    return [
      teamOneIndex !== -1 ? teamOneIndex + 1 : null,
      teamTwoIndex !== -1 ? teamTwoIndex + 1 : null,
    ];
  }
};

export default function TournamentMatchPage() {
  const visibility = useVisibilityChange();
  const { revalidate } = useRevalidator();
  const parentRouteData = useOutletContext<TournamentLoaderData>();
  const data = useLoaderData<typeof loader>();

  const matchIsOver =
    data.match.opponentOne?.result === "win" ||
    data.match.opponentTwo?.result === "win";

  const matchHasTwoTeams = Boolean(
    data.match.opponentOne?.id && data.match.opponentTwo?.id
  );

  React.useEffect(() => {
    if (visibility !== "visible" || matchIsOver) return;

    revalidate();
  }, [visibility, revalidate, matchIsOver]);

  return (
    <div className="stack lg">
      {!matchIsOver && visibility !== "hidden" ? <AutoRefresher /> : null}
      <div className="flex horizontal justify-between items-center">
        {/* TODO: better title */}
        <h2 className="text-lighter text-lg">Match #{data.match.id}</h2>
        <LinkButton
          to={tournamentBracketsPage(parentRouteData.event.id)}
          variant="outlined"
          size="tiny"
          className="w-max"
          icon={<ArrowLongLeftIcon />}
          testId="back-to-bracket-button"
        >
          Back to bracket
        </LinkButton>
      </div>
      {!matchHasTwoTeams ? (
        <div className="text-lg text-lighter font-semi-bold text-center">
          Waiting for teams
        </div>
      ) : null}
      {matchIsOver ? <ResultsSection /> : null}
      {!matchIsOver &&
      typeof data.match.opponentOne?.id === "number" &&
      typeof data.match.opponentTwo?.id === "number" ? (
        <MapListSection
          teams={[data.match.opponentOne.id, data.match.opponentTwo.id]}
        />
      ) : null}
    </div>
  );
}

function AutoRefresher() {
  useAutoRefresh();

  return null;
}

function useAutoRefresh() {
  const { revalidate } = useRevalidator();
  const parentRouteData = useOutletContext<TournamentLoaderData>();
  const data = useLoaderData<typeof loader>();
  const lastEventId = useEventSource(
    tournamentMatchSubscribePage({
      eventId: parentRouteData.event.id,
      matchId: data.match.id,
    }),
    {
      event: matchSubscriptionKey(data.match.id),
    }
  );

  React.useEffect(() => {
    if (lastEventId) {
      revalidate();
    }
  }, [lastEventId, revalidate]);
}

function MapListSection({ teams }: { teams: [id: number, id: number] }) {
  const user = useUser();
  const data = useLoaderData<typeof loader>();
  const parentRouteData = useOutletContext<TournamentLoaderData>();

  const teamOne = parentRouteData.teams.find((team) => team.id === teams[0]);
  const teamTwo = parentRouteData.teams.find((team) => team.id === teams[1]);

  if (!teamOne || !teamTwo) return null;

  const teamOneMaps = new MapPool(teamOne.mapPool ?? []);
  const teamTwoMaps = new MapPool(teamTwo.mapPool ?? []);

  let maps;
  try {
    maps = createTournamentMapList({
      bestOf: data.match.bestOf,
      seed: String(data.match.id),
      modesIncluded: modesIncluded(parentRouteData.event),
      tiebreakerMaps: new MapPool(parentRouteData.tieBreakerMapPool),
      teams: [
        {
          id: teams[0],
          maps: teamOneMaps,
        },
        {
          id: teams[1],
          maps: teamTwoMaps,
        },
      ],
    });
  } catch (e) {
    console.error(
      "Failed to create map list. Falling back to default maps.",
      e
    );

    maps = createTournamentMapList({
      bestOf: data.match.bestOf,
      seed: String(data.match.id),
      modesIncluded: modesIncluded(parentRouteData.event),
      tiebreakerMaps: new MapPool(parentRouteData.tieBreakerMapPool),
      teams: [
        {
          id: -1,
          maps: new MapPool([]),
        },
        {
          id: -2,
          maps: new MapPool([]),
        },
      ],
    });
  }

  const scoreSum =
    (data.match.opponentOne?.score ?? 0) + (data.match.opponentTwo?.score ?? 0);

  const currentStageWithMode = maps[scoreSum];

  invariant(currentStageWithMode, "No map found for this score");

  const isMemberOfATeam =
    teamOne.members.some((m) => m.userId === user?.id) ||
    teamTwo.members.some((m) => m.userId === user?.id);

  return (
    <ScoreReporter
      currentStageWithMode={currentStageWithMode}
      teams={[teamOne, teamTwo]}
      modes={maps.map((map) => map.mode)}
      type={
        canReportTournamentScore({
          event: parentRouteData.event,
          match: data.match,
          ownedTeamId: parentRouteData.ownedTeamId,
          user,
        })
          ? "EDIT"
          : isMemberOfATeam
          ? "MEMBER"
          : "OTHER"
      }
    />
  );
}

function ResultsSection() {
  const data = useLoaderData<typeof loader>();
  const parentRouteData = useOutletContext<TournamentLoaderData>();
  const [selectedResultIndex, setSelectedResultIndex] = useSearchParamState({
    defaultValue: data.results.length - 1,
    name: "result",
    revive: (value) => {
      const maybeIndex = Number(value);
      if (!Number.isInteger(maybeIndex)) return;
      if (maybeIndex < 0 || maybeIndex >= data.results.length) return;

      return maybeIndex;
    },
  });

  const result = data.results[selectedResultIndex];
  invariant(result, "Result is missing");

  const teamOne = parentRouteData.teams.find(
    (team) => team.id === data.match.opponentOne?.id
  );
  const teamTwo = parentRouteData.teams.find(
    (team) => team.id === data.match.opponentTwo?.id
  );

  if (!teamOne || !teamTwo) {
    throw new Error("Team is missing");
  }

  return (
    <ScoreReporter
      currentStageWithMode={result}
      teams={[teamOne, teamTwo]}
      modes={data.results.map((result) => result.mode)}
      selectedResultIndex={selectedResultIndex}
      setSelectedResultIndex={setSelectedResultIndex}
      result={result}
      type="OTHER"
    />
  );
}
