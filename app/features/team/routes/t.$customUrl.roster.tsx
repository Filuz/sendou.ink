import type { LinksFunction } from "@remix-run/node";
import {
  redirect,
  type ActionFunction,
  type LoaderArgs,
} from "@remix-run/node";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import clsx from "clsx";
import * as React from "react";
import { useCopyToClipboard } from "react-use";
import { Alert } from "~/components/Alert";
import { Button } from "~/components/Button";
import { FormWithConfirm } from "~/components/FormWithConfirm";
import { Main } from "~/components/Main";
import { SubmitButton } from "~/components/SubmitButton";
import { useBaseUrl } from "~/hooks/useBaseUrl";
import { useTranslation } from "~/hooks/useTranslation";
import { requireUser, useUser } from "~/modules/auth";
import type { SendouRouteHandle } from "~/utils/remix";
import { notFoundIfFalsy, parseRequestFormData, validate } from "~/utils/remix";
import { discordFullName } from "~/utils/strings";
import { assertUnreachable } from "~/utils/types";
import { joinTeamPage, teamPage } from "~/utils/urls";
import { editRole } from "../queries/editRole.server";
import { findByIdentifier } from "../queries/findByIdentifier.server";
import { inviteCodeById } from "../queries/inviteCodeById.server";
import { leaveTeam } from "../queries/leaveTeam.server";
import { resetInviteLink } from "../queries/resetInviteLink.server";
import { transferOwnership } from "../queries/transferOwnership.server";
import { TEAM_MEMBER_ROLES } from "../team-constants";
import { manageRosterSchema, teamParamsSchema } from "../team-schemas.server";
import type { DetailedTeamMember } from "../team-types";
import { isTeamFull, isTeamOwner } from "../team-utils";
import styles from "../team.css";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: styles }];
};

export const action: ActionFunction = async ({ request, params }) => {
  const user = await requireUser(request);

  const { customUrl } = teamParamsSchema.parse(params);
  const team = notFoundIfFalsy(findByIdentifier(customUrl));
  validate(isTeamOwner({ team, user }));

  const data = await parseRequestFormData({
    request,
    schema: manageRosterSchema,
  });

  switch (data._action) {
    case "DELETE_MEMBER": {
      validate(data.userId !== user.id);
      leaveTeam({ teamId: team.id, userId: data.userId });
      break;
    }
    case "RESET_INVITE_LINK": {
      resetInviteLink(team.id);
      break;
    }
    case "TRANSFER_OWNERSHIP": {
      transferOwnership({
        teamId: team.id,
        newOwnerUserId: data.newOwnerId,
        oldOwnerUserId: user.id,
      });

      return redirect(teamPage(customUrl));
    }
    case "UPDATE_MEMBER_ROLE": {
      editRole({
        role: data.role || null,
        teamId: team.id,
        userId: data.userId,
      });
      break;
    }
    default: {
      assertUnreachable(data);
    }
  }

  return null;
};

export const handle: SendouRouteHandle = {
  i18n: ["team"],
  // breadcrumb: () => ({
  //   imgPath: navIconUrl("object-damage-calculator"),
  //   href: OBJECT_DAMAGE_CALCULATOR_URL,
  //   type: "IMAGE",
  // }),
};

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { customUrl } = teamParamsSchema.parse(params);

  const team = notFoundIfFalsy(findByIdentifier(customUrl));

  if (!isTeamOwner({ team, user })) {
    throw redirect(teamPage(customUrl));
  }

  return {
    team: { ...team, inviteCode: inviteCodeById(team.id)! },
  };
};

export default function ManageTeamRosterPage() {
  return (
    <Main className="stack lg">
      <InviteCodeSection />
      <MemberActions />
    </Main>
  );
}

function InviteCodeSection() {
  const { t } = useTranslation(["common", "team"]);
  const { team } = useLoaderData<typeof loader>();
  const baseUrl = useBaseUrl();
  const [, copyToClipboard] = useCopyToClipboard();

  if (isTeamFull(team)) {
    return (
      <Alert variation="INFO" alertClassName="mx-auto w-max">
        {t("team:roster.teamFull")}
      </Alert>
    );
  }

  const inviteLink = `${baseUrl}${joinTeamPage({
    customUrl: team.customUrl,
    inviteCode: team.inviteCode,
  })}`;

  return (
    <div>
      <h2 className="text-lg">{t("team:roster.inviteLink.header")}</h2>
      <div className="stack md">
        <div className="text-sm">{inviteLink}</div>
        <Form method="post" className="stack horizontal md">
          <Button size="tiny" onClick={() => copyToClipboard(inviteLink)}>
            {t("common:actions.copyToClipboard")}
          </Button>
          <SubmitButton
            variant="minimal-destructive"
            _action="RESET_INVITE_LINK"
            size="tiny"
          >
            {t("common:actions.reset")}
          </SubmitButton>
        </Form>
      </div>
    </div>
  );
}

function MemberActions() {
  const { t } = useTranslation(["team"]);
  const { team } = useLoaderData<typeof loader>();

  return (
    <div className="stack md">
      <h2 className="text-lg">{t("team:roster.members.header")}</h2>

      <div className="team__roster__members">
        {team.members.map((member) => (
          <MemberRow key={member.id} member={member} />
        ))}
      </div>
    </div>
  );
}

const NO_ROLE = "NO_ROLE";
function MemberRow({ member }: { member: DetailedTeamMember }) {
  const { team } = useLoaderData<typeof loader>();
  const { t } = useTranslation(["team"]);
  const user = useUser();
  const roleFetcher = useFetcher();

  const isSelf = user!.id === member.id;
  const role = team.members.find((m) => m.id === member.id)?.role ?? NO_ROLE;

  return (
    <React.Fragment key={member.id}>
      <div className="team__roster__members__member">
        {discordFullName(member)}
      </div>
      <div>
        <select
          defaultValue={role}
          onChange={(e) =>
            roleFetcher.submit(
              {
                _action: "UPDATE_MEMBER_ROLE",
                userId: String(member.id),
                role: e.target.value === NO_ROLE ? "" : e.target.value,
              },
              { method: "post" }
            )
          }
          disabled={roleFetcher.state !== "idle"}
        >
          <option value={NO_ROLE}>No role</option>
          {TEAM_MEMBER_ROLES.map((role) => {
            return (
              <option key={role} value={role}>
                {t(`team:roles.${role}`)}
              </option>
            );
          })}
        </select>
      </div>
      <div className={clsx({ invisible: isSelf })}>
        <FormWithConfirm
          dialogHeading={t("team:kick.header", {
            teamName: team.name,
            user: discordFullName(member),
          })}
          deleteButtonText={t("team:actionButtons.kick")}
          fields={[
            ["_action", "DELETE_MEMBER"],
            ["userId", member.id],
          ]}
        >
          <Button size="tiny" variant="minimal-destructive">
            {t("team:actionButtons.kick")}
          </Button>
        </FormWithConfirm>
      </div>
      <div className={clsx({ invisible: isSelf })}>
        <FormWithConfirm
          dialogHeading={t("team:transferOwnership.header", {
            teamName: team.name,
            user: discordFullName(member),
          })}
          deleteButtonText={t("team:actionButtons.transferOwnership.confirm")}
          fields={[
            ["_action", "TRANSFER_OWNERSHIP"],
            ["newOwnerId", member.id],
          ]}
        >
          <Button size="tiny" variant="minimal-destructive">
            {t("team:actionButtons.transferOwnership")}
          </Button>
        </FormWithConfirm>
      </div>
      <hr className="team__roster__separator" />
    </React.Fragment>
  );
}