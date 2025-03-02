// Copyright 2022 - 2023 Gnuxie <Gnuxie@protonmail.com>
// Copyright 2019 - 2021 The Matrix.org Foundation C.I.C.
//
// SPDX-License-Identifier: AFL-3.0 AND Apache-2.0
//
// SPDX-FileAttributionText: <text>
// This modified file incorporates work from mjolnir
// https://github.com/matrix-org/mjolnir
// </text>

import {
  isError,
  Ok,
  PolicyRoomManager,
  PolicyRuleType,
  RoomInviter,
  RoomResolver,
  RoomUnbanner,
  SetRoomMembership,
  WatchedPolicyRooms,
} from "matrix-protection-suite";
import { LogLevel } from "matrix-bot-sdk";
import {
  isStringUserID,
  MatrixGlob,
  MatrixUserID,
  StringUserID,
} from "@the-draupnir-project/matrix-basic-types";
import {
  describeCommand,
  MatrixRoomIDPresentationType,
  MatrixRoomReferencePresentationSchema,
  MatrixUserIDPresentationType,
  StringPresentationType,
  tuple,
  union,
} from "@the-draupnir-project/interface-manager";
import { Result, ResultError } from "@gnuxie/typescript-result";
import {
  DraupnirContextToCommandContextTranslator,
  DraupnirInterfaceAdaptor,
} from "./DraupnirCommandPrerequisites";
import ManagementRoomOutput from "../managementroom/ManagementRoomOutput";
import { UnlistedUserRedactionQueue } from "../queues/UnlistedUserRedactionQueue";

async function unbanUserFromRooms(
  {
    managementRoomOutput,
    setMembership,
    roomUnbanner,
    noop,
    roomInviter,
  }: DraupnirUnbanCommandContext,
  rule: MatrixGlob,
  invite: boolean = false
) {
  await managementRoomOutput.logMessage(
    LogLevel.INFO,
    "Unban",
    `Unbanning users that match glob: ${rule.regex}`
  );
  for (const revision of setMembership.allRooms) {
    for (const member of revision.members()) {
      if (member.membership !== "ban") {
        continue;
      }
      if (rule.test(member.userID)) {
        await managementRoomOutput.logMessage(
          LogLevel.DEBUG,
          "Unban",
          `Unbanning ${member.userID} in ${revision.room.toRoomIDOrAlias()}` +
            (invite ? ", and re-inviting them." : ""),
          revision.room.toRoomIDOrAlias()
        );
        if (!noop) {
          await roomUnbanner.unbanUser(
            revision.room.toRoomIDOrAlias(),
            member.userID
          );
          const inviteResult = await roomInviter.inviteUser(
            revision.room,
            member.userID
          );
          if (isError(inviteResult)) {
            await managementRoomOutput.logMessage(
              LogLevel.WARN,
              "Unban",
              `Failed to re-invite ${member.userID} to ${revision.room.toRoomIDOrAlias()}`,
              revision.room.toRoomIDOrAlias()
            );
          }
        } else {
          await managementRoomOutput.logMessage(
            LogLevel.WARN,
            "Unban",
            `Attempted to unban ${member.userID} in ${revision.room.toRoomIDOrAlias()} but Draupnir is running in no-op mode`,
            revision.room.toRoomIDOrAlias()
          );
        }
      }
    }
  }
}

export type DraupnirUnbanCommandContext = {
  policyRoomManager: PolicyRoomManager;
  watchedPolicyRooms: WatchedPolicyRooms;
  roomResolver: RoomResolver;
  clientUserID: StringUserID;
  setMembership: SetRoomMembership;
  managementRoomOutput: ManagementRoomOutput;
  noop: boolean;
  roomUnbanner: RoomUnbanner;
  unlistedUserRedactionQueue: UnlistedUserRedactionQueue;
  roomInviter: RoomInviter;
};

export const DraupnirUnbanCommand = describeCommand({
  summary: "Removes an entity from a policy list.",
  parameters: tuple(
    {
      name: "entity",
      description:
        "The entity to ban. This can be a user ID, room ID, or server name.",
      acceptor: union(
        MatrixUserIDPresentationType,
        MatrixRoomReferencePresentationSchema,
        StringPresentationType
      ),
    },
    {
      name: "list",
      acceptor: union(
        MatrixRoomReferencePresentationSchema,
        StringPresentationType
      ),
      prompt: async function ({
        policyRoomManager,
        clientUserID,
      }: DraupnirUnbanCommandContext) {
        return Ok({
          suggestions: policyRoomManager
            .getEditablePolicyRoomIDs(clientUserID, PolicyRuleType.User)
            .map((room) => MatrixRoomIDPresentationType.wrap(room)),
        });
      },
    }
  ),
  // This is a legacy option to unban the user from all rooms that we now ignore just so providing the option doesn't
  // cause an error.
  keywords: {
    keywordDescriptions: {
      true: {
        isFlag: true,
        description:
          "Legacy, now redundant option to unban the user from all rooms.",
      },
      invite: {
        isFlag: true,
        description:
          "Re-invite the unbanned user to any rooms they were unbanned from.",
      },
    },
  },
  async executor(
    context: DraupnirUnbanCommandContext,
    _info,
    keywords,
    _rest,
    entity,
    policyRoomDesignator
  ): Promise<Result<void>> {
    const {
      roomResolver,
      policyRoomManager,
      watchedPolicyRooms,
      unlistedUserRedactionQueue,
    } = context;
    const policyRoomReference =
      typeof policyRoomDesignator === "string"
        ? Ok(
            watchedPolicyRooms.findPolicyRoomFromShortcode(policyRoomDesignator)
              ?.room
          )
        : Ok(policyRoomDesignator);
    if (isError(policyRoomReference)) {
      return policyRoomReference;
    }
    if (policyRoomReference.ok === undefined) {
      return ResultError.Result(
        `Unable to find a policy room from the shortcode ${policyRoomDesignator.toString()}`
      );
    }
    const policyRoom = await roomResolver.resolveRoom(policyRoomReference.ok);
    if (isError(policyRoom)) {
      return policyRoom;
    }
    const policyRoomEditor = await policyRoomManager.getPolicyRoomEditor(
      policyRoom.ok
    );
    if (isError(policyRoomEditor)) {
      return policyRoomEditor;
    }
    const policyRoomUnban =
      entity instanceof MatrixUserID
        ? await policyRoomEditor.ok.unbanEntity(
            PolicyRuleType.User,
            entity.toString()
          )
        : typeof entity === "string"
          ? await policyRoomEditor.ok.unbanEntity(PolicyRuleType.Server, entity)
          : await (async () => {
              const bannedRoom = await roomResolver.resolveRoom(entity);
              if (isError(bannedRoom)) {
                return bannedRoom;
              }
              return await policyRoomEditor.ok.unbanEntity(
                PolicyRuleType.Room,
                bannedRoom.ok.toRoomIDOrAlias()
              );
            })();
    if (isError(policyRoomUnban)) {
      return policyRoomUnban;
    }
    if (typeof entity === "string" || entity instanceof MatrixUserID) {
      const rawEnttiy = typeof entity === "string" ? entity : entity.toString();
      const rule = new MatrixGlob(entity.toString());
      if (isStringUserID(rawEnttiy)) {
        unlistedUserRedactionQueue.removeUser(rawEnttiy);
      }
      await unbanUserFromRooms(
        context,
        rule,
        keywords.getKeywordValue("invite")
      );
    }
    return Ok(undefined);
  },
});

DraupnirContextToCommandContextTranslator.registerTranslation(
  DraupnirUnbanCommand,
  function (draupnir) {
    return {
      policyRoomManager: draupnir.policyRoomManager,
      watchedPolicyRooms: draupnir.protectedRoomsSet.watchedPolicyRooms,
      roomResolver: draupnir.clientPlatform.toRoomResolver(),
      clientUserID: draupnir.clientUserID,
      setMembership: draupnir.protectedRoomsSet.setRoomMembership,
      managementRoomOutput: draupnir.managementRoomOutput,
      noop: draupnir.config.noop,
      roomUnbanner: draupnir.clientPlatform.toRoomUnbanner(),
      unlistedUserRedactionQueue: draupnir.unlistedUserRedactionQueue,
      roomInviter: draupnir.clientPlatform.toRoomInviter(),
    };
  }
);

DraupnirInterfaceAdaptor.describeRenderer(DraupnirUnbanCommand, {
  isAlwaysSupposedToUseDefaultRenderer: true,
});
