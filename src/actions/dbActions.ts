"use server";
import prisma from "@/lib/db";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/validateReq";
import { revalidatePath } from "next/cache";
import { Expense, FriendTable } from "@/lib/types";

export async function createGroup(formData: FormData) {
  const { user } = await validateRequest();
  const groupName = formData.get("name") as string;
  await prisma.group.create({
    data: {
      id: randomUUID(),
      name: groupName,
      users: {
        connect: { id: user?.id },
      },
    },
  });
  revalidatePath("/home");
}

export async function joinGroup(formData: FormData) {
  const groupId = formData.get("code") as string;
  const { user } = await validateRequest();
  const target = await prisma.group.findUnique({
    where: {
      id: groupId,
    },
  });
  if (target && user) {
    await prisma.group.update({
      where: {
        id: target.id,
      },
      data: {
        users: { connect: { id: user.id } },
      },
    });
  }
  revalidatePath("/home");
}

export const leave = async (groupId: string, userId: string) => {
  await prisma.group.update({
    where: {
      id: groupId,
    },
    data: {
      users: { disconnect: { id: userId } },
    },
  });
  revalidatePath("/home");
};

export const addExpense = async (formData: FormData) => {
  const title = formData.get("title") as string;
  const amount = formData.get("amount") as unknown;
  const groupId = formData.get("groupId") as string;
  const userId = formData.get("paidBy") as string;
  const path = formData.get("path") as string;
  const debtors = JSON.parse(formData.get("debtors") as string) as unknown;
  const percent = JSON.parse(formData.get("percent") as string) as Record<
    string,
    string
  >;
  const type = formData.get("type") as string;
  const createdBy = formData.get("createdBy") as string;
  if (Object.values(percent).length) {
    const val = Object.values(percent).reduce((a, v) => a + parseFloat(v), 0);
    if (val !== 100) return;
  }
  const expense = await prisma.expense.create({
    data: {
      title,
      status: false,
      amount: parseFloat(amount as string),
      userId,
      groupId,
      createdBy,
      percentages: JSON.stringify(percent),
    },
  });
  await createDebtor(
    expense.id,
    debtors as { id: string; username: string; password: string }[],
    percent as Record<string, string>,
    amount as string,
    type,
    path
  );
};

const createDebtor = async (
  expenseId: number,
  debtors: { id: string; username: string; password: string }[],
  percent: Record<string, string>,
  amount: string,
  type: string,
  path: string
) => {
  if (type == "equal") {
    const divident = parseFloat(amount) / debtors.length;
    for (let debtor of debtors) {
      await prisma.expenseDebt.create({
        data: {
          settled: false,
          amount: divident,
          expenseId,
          debtorId: debtor.username,
        },
      });
    }
  } else {
    for (let debtor of debtors) {
      const percentage = parseFloat(percent[debtor.username]);
      const divident = (percentage / 100) * parseFloat(amount);
      await prisma.expenseDebt.create({
        data: {
          settled: false,
          amount: divident,
          expenseId,
          debtorId: debtor.username,
        },
      });
    }
  }
  revalidatePath(path);
};

export const deleteExpense = async (expenseId: number, path: string) => {
  await prisma.expenseDebt.deleteMany({
    where: {
      expenseId,
    },
  });
  await prisma.expense.delete({
    where: {
      id: expenseId,
    },
  });
  revalidatePath(path);
};

export const resolveExpense = async (
  message: string,
  path: string,
  expenseId: number,
  debtorId: string
) => {
  if (message == "Resolve") {
    await prisma.expense.update({
      where: {
        id: expenseId,
      },
      data: {
        status: true,
      },
    });
  } else {
    await prisma.expenseDebt.update({
      where: {
        expenseId_debtorId: {
          expenseId,
          debtorId,
        },
      },
      data: {
        settled: true,
      },
    });
  }
  revalidatePath(path);
};

export const allYerOwes = async (groupId: string, username: string) => {
  let amount = 0;
  const getAllExpenses = await prisma.expense.findMany({
    where: {
      groupId,
    },
    include: {
      debtors: true,
    },
  });
  const filteredExpenses = getAllExpenses.filter(
    (exp) =>
      exp.debtors.find((d) => d.debtorId == username) || exp.userId == username
  );
  filteredExpenses.forEach((exp) => {
    if (exp.userId == username) {
      const returnAmount = exp.debtors
        .filter((d) => d.debtorId != username)
        .reduce((s, d) => s + d.amount, 0);
      amount += returnAmount;
    } else
      amount -= exp.debtors.find((d) => d.debtorId == username)
        ?.amount as number;
  });
  return amount;
};

export const getFriendData = async (groupId: string, userId: string) => {
  const data = [];
  const groupMembers = await prisma.group.findUnique({
    where: {
      id: groupId,
    },
    include: {
      users: true,
    },
  });
  if (groupMembers?.users.length) {
    for (let i = 0; i < groupMembers?.users.length; i++) {
      const friend = groupMembers.users[i];
      let user: FriendTable = {
        name: friend.username,
        involvedExpenses: null,
        status: false,
        money: 0,
      };
      const involvedExpenses = await prisma.expense.findMany({
        where: {
          OR: [
            {
              AND: [
                {
                  userId,
                },
                {
                  debtors: {
                    some: {
                      debtorId: friend.username,
                    },
                  },
                },
              ],
            },
            {
              AND: [
                {
                  userId: friend.username,
                },
                {
                  debtors: {
                    some: {
                      debtorId: userId,
                    },
                  },
                },
              ],
            },
          ],
        },
        include: {
          debtors: true,
        },
      });
      user.involvedExpenses = involvedExpenses;
      user.status = involvedExpenses.every((exp) => exp.status == true);
      user.money = calcOG(involvedExpenses, userId, friend.username);
      data.push(user);
    }
  }
  return data;
};

function calcOG(expenses: Expense, userId: string, friendId: string) {
  let amount = 0;
  expenses.forEach((exp) => {
    if (exp.userId == userId)
      amount += exp.debtors.find((d) => d.debtorId == friendId)
        ?.amount as number;
    else
      amount -= exp.debtors.find((d) => d.debtorId == userId)?.amount as number;
  });
  return amount;
}
